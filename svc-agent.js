#!/usr/bin/env node
/**
 * TDS Service Health Agent — WebSocket edition (no inbound ports by default)
 * Platforms:
 *   - Linux (systemd): enumerates with `systemctl`
 *   - macOS (launchd): enumerates with `launchctl`
 * Features:
 *   - Persistent outbound WebSocket to central server (two-way)
 *   - Optional local HTTP endpoints (disabled by default)
 *   - Stable systemId generation & persistence
 *   - Optional Docker container enumeration
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { exec } = require("child_process");
const WebSocket = require("ws"); // ensure dependency in package.json
// HTTP/Prometheus are optional; required only if enabled
let express = null;
let prom = null;

// ---------- Config ----------
const CONFIG_PATHS = [
  path.join(process.cwd(), "tds-svc-agent.json"), // 1) current working dir
  process.env.SVC_AGENT_CONFIG || "",             // 2) env override
  "/etc/tds-svc-agent.json",                      // 3) system-wide
  path.join(__dirname, "tds-svc-agent.json"),     // 4) alongside script
].filter(Boolean);

const defaults = {
  // Optional local HTTP (disabled by default so nothing is exposed)
  http: {
    enabled: false,
    port: Number(process.env.PORT || 8088),
    bind: process.env.BIND || "127.0.0.1",
    prometheus: true, // only effective if http.enabled = true
  },

  include: [], // e.g. ["nginx.service"]
  exclude: [], // e.g. ["snapd.service"]

  // WebSocket to central
  ws: {
    url: process.env.CENTRAL_WS_URL || "", // e.g. "wss://collector.tds/agent"
    token: process.env.AUTH_TOKEN || "",   // Bearer token
    // TLS: set to true ONLY if you know what you’re doing
    insecureSkipTlsVerify: process.env.WS_INSECURE === "true" || false,
    heartbeatSec: Number(process.env.WS_HEARTBEAT || 25),
    reconnectBaseMs: Number(process.env.WS_RECONNECT_BASE || 1000),
    reconnectMaxMs: Number(process.env.WS_RECONNECT_MAX || 30000),
  },

  // Periodic snapshot push over WS
  reporting: {
    intervalSec: Number(process.env.REPORT_INTERVAL || 30),
    sendOnConnect: true,
  },

  docker: {
    enabled: process.env.DOCKER_ENABLED === "true" || false,
    binary: process.env.DOCKER_BIN || "docker",
  },

  // Optional hard-override for systemId
  systemId: undefined,
};

let config = { ...defaults };
for (const p of CONFIG_PATHS) {
  try {
    if (p && fs.existsSync(p)) {
      const loaded = JSON.parse(fs.readFileSync(p, "utf8"));
      config = { ...config, ...loaded };
      console.log(`[svc-agent] Loaded config from ${p}`);
      break;
    }
  } catch (e) {
    console.error("[svc-agent] Config load error:", e.message);
  }
}

const HOSTNAME = os.hostname();

// ---------- Helpers ----------
const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";

function execCmd(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({
            err,
            stdout,
            stderr,
            code: (err && typeof err.code !== "undefined") ? err.code : 0
          });
    });
  });
}

const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

const mkId = (serviceName) => `${slug(HOSTNAME)}:${slug(serviceName)}`;
let SYSTEM_ID = "unknown";
const mkGlobalId = (serviceName) => `${SYSTEM_ID}:${slug(serviceName)}`;

async function runLocalInstallSh(extraArgs = [], extraEnv = {}) {
    const installSh = path.join(__dirname, "scripts", "install.sh");
    if (!fs.existsSync(installSh)) throw new Error(`install.sh not found at ${installSh}`);
    try { fs.chmodSync(installSh, 0o755); } catch (_) {}
  
    const cmd = `"${installSh}" ${extraArgs.map(a => `"${a}"`).join(" ")}`.trim();
    return new Promise((resolve, reject) => {
      const child = require("child_process").spawn(cmd, {
        shell: true,
        env: { ...process.env, ...extraEnv },   // <— merge in env from WS
        cwd: __dirname,
      });
  
      let out = "", err = "";
      child.stdout.on("data", d => { out += d.toString(); });
      child.stderr.on("data", d => { err += d.toString(); });
  
      child.on("close", code => {
        if (code !== 0) {
          reject(new Error(`install.sh failed (code ${code}): ${err || out || code}`.trim()));
        } else {
          resolve({ code, stdout: (out || "").slice(-4000) });
        }
      });
    });
  }
  
  async function restartSelf() {
    // systemd if available
    if (isLinux && fs.existsSync("/run/systemd/system")) {
      const unit = process.env.SVC_UNIT || "tds-svc-agent.service";
      const r = await execCmd(`systemctl restart ${unit}`);
      if (r.code !== 0) {
        console.warn("[svc-agent] systemctl restart failed; exiting so supervisor can restart.");
        process.exit(0);
      }
      return;
    }
    // launchd (if you run under a label)
    if (isMac) {
      const label = process.env.LAUNCHD_LABEL;
      if (label) {
        await execCmd(`launchctl kickstart -k gui/${process.getuid()}/${label} || launchctl kickstart -k system/${label}`);
        return;
      }
    }
    // fallback: relaunch process, then exit
    try {
      const child = require("child_process").spawn(process.execPath, [process.argv[1]], {
        detached: true, stdio: "ignore", cwd: process.cwd(), env: process.env,
      });
      child.unref();
    } catch (e) {
      console.warn("[svc-agent] self relaunch failed:", e.message);
    }
    process.exit(0);
  }
  

// ---------- System ID (stable, unique per machine) ----------
const ID_FILE_CANDIDATES = [
  process.env.SVC_AGENT_ID_PATH || "",           // explicit override path
  "/etc/tds-svc-agent.id",                       // system-wide (Linux)
  path.join(process.cwd(), ".tds-svc-agent.id"), // working dir
  path.join(__dirname, ".tds-svc-agent.id"),     // alongside script
].filter(Boolean);

async function readFirstExisting(paths) {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
    } catch (_) {}
  }
  return null;
}

async function writeFirstWritable(paths, value) {
  for (const p of paths) {
    try {
      fs.writeFileSync(p, value + "\n", { mode: 0o600 });
      return p;
    } catch (_) {}
  }
  return null;
}

async function getLinuxMachineId() {
  try {
    const a = "/etc/machine-id";
    const b = "/var/lib/dbus/machine-id";
    if (fs.existsSync(a)) return fs.readFileSync(a, "utf8").trim();
    if (fs.existsSync(b)) return fs.readFileSync(b, "utf8").trim();
  } catch (_) {}
  return null;
}

async function getMacPlatformUUID() {
  try {
    const { stdout } = await execCmd(
      `/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice | awk -F'"' '/IOPlatformUUID/ {print $4}'`
    );
    const v = stdout.trim();
    return v || null;
  } catch (_) {
    return null;
  }
}

async function initSystemId() {
  if (config.systemId) return String(config.systemId).trim();

  const persisted = await readFirstExisting(ID_FILE_CANDIDATES);
  if (persisted) return persisted;

  let osId = null;
  if (isLinux) osId = await getLinuxMachineId();
  else if (isMac) osId = await getMacPlatformUUID();

  if (!osId) {
    try {
      const ifaces = os.networkInterfaces();
      const macs = Object.values(ifaces)
        .flat()
        .filter(Boolean)
        .map((i) => i.mac)
        .filter((m) => m && m !== "00:00:00:00:00:00")
        .sort()
        .join(",");
      const hash = crypto
        .createHash("sha256")
        .update(`${HOSTNAME}|${macs}`)
        .digest("hex")
        .slice(0, 32);
      osId = `sha256-${hash}`;
    } catch (e) {
      osId = null;
    }
  }

  if (!osId) osId = crypto.randomUUID();
  await writeFirstWritable(ID_FILE_CANDIDATES, osId);
  return osId;
}

// ---------- Enumerators ----------
async function listSystemdServices() {
  const cmd =
    "systemctl show --type=service --all --no-page --property=Id,Description,LoadState,ActiveState,SubState,UnitFileState,FragmentPath";
  const { stdout } = await execCmd(cmd);

  const sections = stdout.split("\n\n").map((b) => b.trim()).filter(Boolean);
  const services = [];
  for (const sec of sections) {
    const lines = sec.split("\n");
    const obj = {};
    for (const line of lines) {
      const idx = line.indexOf("=");
      if (idx > 0) {
        const k = line.slice(0, idx);
        const v = line.slice(idx + 1);
        obj[k] = v;
      }
    }
    if (!obj.Id || !obj.Id.endsWith(".service")) continue;

    if (config.include.length && !config.include.includes(obj.Id)) continue;
    if (config.exclude.includes(obj.Id)) continue;

    const name = obj.Id;
    services.push({
      id: mkId(name),
      gid: mkGlobalId(name),
      systemId: SYSTEM_ID,
      host: HOSTNAME,
      service: name,
      description: obj.Description || "",
      load: obj.LoadState || "unknown",
      active: obj.ActiveState || "unknown",
      sub: obj.SubState || "unknown",
      unitFileState: obj.UnitFileState || "unknown",
      path: obj.FragmentPath || "",
      healthy:
        (obj.ActiveState === "active" && obj.SubState === "running") ||
        obj.ActiveState === "active",
      updatedAt: new Date().toISOString(),
      platform: "linux",
    });
  }
  return services.sort((a, b) => a.service.localeCompare(b.service));
}

async function listLaunchdServices() {
  const { stdout } = await execCmd("launchctl list || true");
  const lines = stdout.split("\n").slice(1);
  const services = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    const label = parts[parts.length - 1];
    if (!label) continue;

    const pidRaw = parts[0];
    const statusRaw = parts[1];
    const running = pidRaw && pidRaw !== "-" && /^\d+$/.test(pidRaw);
    const statusNum = Number(statusRaw);
    const healthy = running && (isNaN(statusNum) || statusNum === 0);

    if (config.include.length && !config.include.includes(label)) continue;
    if (config.exclude.includes(label)) continue;

    services.push({
      id: mkId(label),
      gid: mkGlobalId(label),
      systemId: SYSTEM_ID,
      host: HOSTNAME,
      service: label,
      description: "",
      load: running ? "loaded" : "not-loaded",
      active: running ? "active" : "inactive",
      sub: running ? "running" : "stopped",
      unitFileState: "unknown",
      path: "",
      healthy,
      updatedAt: new Date().toISOString(),
      platform: "darwin",
    });
  }
  return services.sort((a, b) => a.service.localeCompare(b.service));
}

async function listDockerContainers() {
  if (!config.docker.enabled) return [];
  const { stdout } = await execCmd(
    `${config.docker.binary} ps --format "{{.ID}}|{{.Names}}|{{.Status}}"`
  );
  const lines = stdout.trim().split("\n").filter(Boolean);
  return lines.map((l) => {
    const [id, name, status] = l.split("|");
    const up = /Up\s/i.test(status);
    return {
      id: mkId(`docker:${name}`),
      gid: mkGlobalId(`docker:${name}`),
      systemId: SYSTEM_ID,
      host: HOSTNAME,
      service: `docker:${name}`,
      description: `Container ${id}`,
      load: "loaded",
      active: up ? "active" : "inactive",
      sub: status,
      unitFileState: "container",
      path: "",
      healthy: up,
      updatedAt: new Date().toISOString(),
      platform: "docker",
    };
  });
}

// ---------- Snapshot + Cache ----------
let lastSnapshot = { services: [], takenAt: null };

async function takeSnapshot() {
  const parts = [];
  if (isLinux) parts.push(listSystemdServices());
  if (isMac) parts.push(listLaunchdServices());
  if (config.docker.enabled) parts.push(listDockerContainers());
  const combined = (await Promise.all(parts)).flat();
  lastSnapshot = {
    services: combined,
    takenAt: new Date().toISOString(),
  };
  return lastSnapshot;
}

// ---------- WS Client (two-way) ----------
let ws = null;
let wsTimerHeartbeat = null;
let wsTimerReconnect = null;
let lastPongAt = 0;
let reconnectAttempts = 0;

function wsLog(...args) {
  console.log("[ws]", ...args);
}

function wsSend(obj) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }catch (e) {}
}

function scheduleReconnect() {
  if (wsTimerReconnect) return;
  const base = Math.max(100, config.ws.reconnectBaseMs || 1000);
  const max = Math.max(base, config.ws.reconnectMaxMs || 30000);
  const jitter = Math.floor(Math.random() * 200);
  const backoff = Math.min(max, Math.floor(base * Math.pow(2, reconnectAttempts)));
  const delay = backoff + jitter;
  wsLog(`reconnecting in ${delay}ms (attempt ${reconnectAttempts + 1})`);
  wsTimerReconnect = setTimeout(() => {
    wsTimerReconnect = null;
    connectWS();
  }, delay);
}

async function handleMessage(msg) {
  let data = null;
  try {
    data = JSON.parse(msg);
  } catch (_) {
    return;
  }
  const { type, id } = data || {};

  switch (type) {
    case "ping":
      wsSend({ type: "pong", ts: Date.now() });
      return;

    case "getSnapshot": {
      const snap = await takeSnapshot();
      wsSend({
        type: "snapshot",
        id, // echo request id if provided
        systemId: SYSTEM_ID,
        host: HOSTNAME,
        takenAt: snap.takenAt,
        services: snap.services,
        agent: {
          version: "2.0.0-ws",
          platform: process.platform,
          node: process.version,
        },
      });
      return;
    }

    case "refresh": {
      const snap = await takeSnapshot();
      wsSend({ type: "ok", id, takenAt: snap.takenAt, count: snap.services.length });
      // Optionally also stream the snapshot back:
      wsSend({
        type: "snapshot",
        systemId: SYSTEM_ID,
        host: HOSTNAME,
        takenAt: snap.takenAt,
        services: snap.services,
        agent: {
          version: "2.0.0-ws",
          platform: process.platform,
          node: process.version,
        },
      });
      return;
    }

    case "runInstall": {
        const args = Array.isArray(data.args) ? data.args : [];
        const restart = !!data.restart;
        const env = (data.env && typeof data.env === "object") ? data.env : {};
        try {
          const res = await runLocalInstallSh(args, env);
          wsSend({ type: "installResult", id, ok: true, stdout: res.stdout });
          if (restart) setTimeout(() => { restartSelf(); }, 500);
        } catch (e) {
          wsSend({ type: "installResult", id, ok: false, error: e.message || String(e) });
        }
        return;
      }

    default:
      // unknown / ignored
      return;
  }
}

function startHeartbeat() {
  stopHeartbeat();
  const interval = Math.max(5, config.ws.heartbeatSec || 25) * 1000;
  wsTimerHeartbeat = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Use WebSocket-level ping frame; ws will auto emit 'pong'
    try {
      ws.ping();
    } catch (_) {}
    // Detect stale
    const now = Date.now();
    if (lastPongAt && now - lastPongAt > interval * 2) {
      wsLog("heartbeat timeout; closing socket");
      try { ws.terminate(); } catch (_) {}
    }
  }, Math.floor((config.ws.heartbeatSec || 25) * 1000));
}

function stopHeartbeat() {
  if (wsTimerHeartbeat) {
    clearInterval(wsTimerHeartbeat);
    wsTimerHeartbeat = null;
  }
}

function connectWS() {
  if (!config.ws.url) {
    console.error("[svc-agent] No ws.url configured; cannot connect.");
    return;
  }

  const headers = {};
  if (config.ws.token) headers["authorization"] = `Bearer ${config.ws.token}`;

  const url = new URL(config.ws.url);
  // Add identity hints in query (server can cross-check against headers)
  url.searchParams.set("systemId", SYSTEM_ID);
  url.searchParams.set("host", HOSTNAME);

  const wsOptions = {
    headers,
    perMessageDeflate: true,
    rejectUnauthorized: !config.ws.insecureSkipTlsVerify,
  };

  ws = new WebSocket(url.toString(), wsOptions);

  ws.on("open", async () => {
    reconnectAttempts = 0;
    lastPongAt = Date.now();
    wsLog("connected");
    startHeartbeat();

    // Say hello
    wsSend({
      type: "hello",
      systemId: SYSTEM_ID,
      host: HOSTNAME,
      caps: {
        docker: !!config.docker.enabled,
        http: !!config.http.enabled,
        platform: process.platform,
      },
      agent: { version: "2.0.0-ws", node: process.version },
      ts: Date.now(),
    });

    if (config.reporting.sendOnConnect) {
      const snap = await takeSnapshot();
      wsSend({
        type: "snapshot",
        systemId: SYSTEM_ID,
        host: HOSTNAME,
        takenAt: snap.takenAt,
        services: snap.services,
        agent: { version: "2.0.0-ws", platform: process.platform, node: process.version },
      });
    }
  });

  ws.on("message", (data) => {
    try {
      handleMessage(data.toString());
    } catch (e) {
      wsLog("message error", e.message);
    }
  });

  ws.on("pong", () => {
    lastPongAt = Date.now();
  });

  ws.on("close", (code, reason) => {
    stopHeartbeat();
    wsLog(`closed (${code}) ${reason ? reason.toString() : ""}`);
    reconnectAttempts++;
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    wsLog("error:", err.message);
    // socket will close, reconnect will schedule in 'close'
  });
}

// ---------- Optional local HTTP (disabled by default) ----------
let httpServer = null;
let gaugeServiceHealthy = null;
let gaugeServicesCount = null;

function updateMetrics(snapshot) {
  if (!prom || !gaugeServiceHealthy || !gaugeServicesCount) return;
  gaugeServicesCount.set({ host: HOSTNAME }, snapshot.services.length);
  snapshot.services.forEach((s) => {
    gaugeServiceHealthy.set(
      { host: s.host, service: s.service, platform: s.platform },
      s.healthy ? 1 : 0
    );
  });
}

async function maybeStartHttp() {
  if (!config.http || !config.http.enabled) return;

  express = require("express");
  prom = require("prom-client");

  const app = express();
  app.use(express.json());

  const collectDefaultMetrics = prom.collectDefaultMetrics;
  collectDefaultMetrics();

  gaugeServiceHealthy = new prom.Gauge({
    name: "tds_service_healthy",
    help: "1 if the service is healthy, else 0",
    labelNames: ["host", "service", "platform"],
  });

  gaugeServicesCount = new prom.Gauge({
    name: "tds_services_count",
    help: "Number of services reported",
    labelNames: ["host"],
  });

  // Minimal safe endpoints (local by default)
  app.get("/health", async (_req, res) => {
    if (!lastSnapshot.takenAt) await takeSnapshot();
    res.json({
      ok: true,
      host: HOSTNAME,
      systemId: SYSTEM_ID,
      takenAt: lastSnapshot.takenAt,
      servicesCount: lastSnapshot.services.length,
      agent: { version: "2.0.0-ws", platform: process.platform, node: process.version },
    });
  });

  app.get("/services", async (_req, res) => {
    if (!lastSnapshot.takenAt) await takeSnapshot();
    res.json(lastSnapshot);
  });

  app.post("/refresh", async (_req, res) => {
    const snap = await takeSnapshot();
    updateMetrics(snap);
    res.json({ ok: true, takenAt: snap.takenAt, services: snap.services.length });
  });

  if (config.http.prometheus) {
    app.get("/metrics", async (_req, res) => {
      res.set("Content-Type", prom.register.contentType);
      res.end(await prom.register.metrics());
    });
  }

  await new Promise((resolve) => {
    httpServer = app.listen(config.http.port, config.http.bind, resolve);
  });
  console.log(
    `[svc-agent] HTTP ${config.http.bind}:${config.http.port} (enabled=${config.http.enabled})`
  );
}

// ---------- Periodic reporting ----------
let timerReport = null;
function startPeriodicReports() {
  const ms = Math.max(5, config.reporting.intervalSec || 30) * 1000;
  stopPeriodicReports();
  timerReport = setInterval(async () => {
    const snap = await takeSnapshot();
    updateMetrics(snap);
    wsSend({
      type: "snapshot",
      systemId: SYSTEM_ID,
      host: HOSTNAME,
      takenAt: snap.takenAt,
      services: snap.services,
      agent: { version: "2.0.0-ws", platform: process.platform, node: process.version },
    });
  }, ms);
}
function stopPeriodicReports() {
  if (timerReport) clearInterval(timerReport);
  timerReport = null;
}

// ---------- Boot ----------
(async function boot() {
  SYSTEM_ID = await initSystemId();
  console.log(`[svc-agent] host=${HOSTNAME} systemId=${SYSTEM_ID}`);

  await takeSnapshot(); // prime
  await maybeStartHttp();
  connectWS();
  startPeriodicReports();

  function shutdown(sig) {
    console.log(`[svc-agent] ${sig} received, shutting down`);
    stopHeartbeat();
    stopPeriodicReports();
    try { ws && ws.close(); } catch (_) {}
    try { httpServer && httpServer.close(); } catch (_) {}
    setTimeout(() => process.exit(0), 300);
  }
  ["SIGINT", "SIGTERM"].forEach((sig) => process.on(sig, () => shutdown(sig)));
})();
