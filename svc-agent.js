#!/usr/bin/env node
/**
 * TDS Service Health Agent
 * - Linux (systemd): enumerates with `systemctl`
 * - macOS (launchd): enumerates with `launchctl`
 * - HTTP API: /health, /services, /services/:id, /metrics
 * - Optional push to central collector
 */
const os = require("os");
const http = require("http");
const crypto = require("crypto");
const { exec } = require("child_process");
const express = require("express");
const prom = require("prom-client");
const fs = require("fs");
const path = require("path");

// ---------- Config ----------
const CONFIG_PATHS = [
  path.join(process.cwd(), "tds-svc-agent.json"), // 1) current working dir
  process.env.SVC_AGENT_CONFIG || "",             // 2) env override
  "/etc/tds-svc-agent.json",                      // 3) system-wide
  path.join(__dirname, "tds-svc-agent.json"),     // 4) alongside script
].filter(Boolean);

const defaults = {
  port: Number(process.env.PORT || 8088),
  bind: process.env.BIND || "0.0.0.0",
  include: [],
  exclude: [],
  push: {
    enabled: process.env.PUSH_ENABLED === "true" || false,
    url: process.env.CENTRAL_URL || "",
    intervalSec: Number(process.env.PUSH_INTERVAL || 60),
    token: process.env.AUTH_TOKEN || "",
  },
  docker: {
    enabled: process.env.DOCKER_ENABLED === "true" || false,
    binary: process.env.DOCKER_BIN || "docker",
  },
};

let config = { ...defaults };
for (const p of CONFIG_PATHS) {
  try {
    if (fs.existsSync(p)) {
      const loaded = JSON.parse(fs.readFileSync(p, "utf8"));
      config = { ...config, ...loaded };
      console.log(`[svc-agent] Loaded config from ${p}`);
      break;
    }
  } catch (e) {
    console.error("Config load error:", e.message);
  }
}

const HOSTNAME = os.hostname();

// ---------- System ID (stable, unique per machine) ----------
const ID_FILE_CANDIDATES = [
    process.env.SVC_AGENT_ID_PATH || "",                 // explicit override
    "/etc/tds-svc-agent.id",                             // system-wide (Linux)
    path.join(process.cwd(), ".tds-svc-agent.id"),       // working dir
    path.join(__dirname, ".tds-svc-agent.id"),           // alongside script
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
    // 1) Config override
    if (config.systemId) return String(config.systemId).trim();
  
    // 2) Previously persisted file (any location)
    const persisted = await readFirstExisting(ID_FILE_CANDIDATES);
    if (persisted) return persisted;
  
    // 3) OS-native IDs
    let osId = null;
    if (process.platform === "linux") osId = await getLinuxMachineId();
    else if (process.platform === "darwin") osId = await getMacPlatformUUID();
  
    // 4) Fallback: hash of hostname + MACs (stable if NICs stable)
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
      } catch {
        osId = null;
      }
    }
  
    // 5) Absolute fallback: random UUIDv4
    if (!osId) osId = crypto.randomUUID();
  
    // Persist for stability
    await writeFirstWritable(ID_FILE_CANDIDATES, osId);
    return osId;
  }
// ---------- Helpers ----------
const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

const mkId = (serviceName) => `${slug(HOSTNAME)}:${slug(serviceName)}`; // keep existing behavior
let SYSTEM_ID = "unknown"; // will be initialized below
const mkGlobalId = (serviceName) => `${SYSTEM_ID}:${slug(serviceName)}`; // globally unique service id

function execCmd(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout, stderr, code: err?.code ?? 0 });
    });
  });
}


const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";

// ---------- Enumerators ----------
async function listSystemdServices() {
  // Robust: use `systemctl show` to get key=val; avoid column parsing.
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

    // filters
    if (config.include.length && !config.include.includes(obj.Id)) continue;
    if (config.exclude.includes(obj.Id)) continue;

    const name = obj.Id;
    const id = mkId(name);
    services.push({
      id,
      host: HOSTNAME,
      service: name,
      systemId: SYSTEM_ID,
      description: obj.Description || "",
      load: obj.LoadState || "unknown",
      active: obj.ActiveState || "unknown",
      sub: obj.SubState || "unknown",
      unitFileState: obj.UnitFileState || "unknown",
      path: obj.FragmentPath || "",
      // convenience derived field
      healthy: (obj.ActiveState === "active" && obj.SubState === "running") || obj.ActiveState === "active",
      updatedAt: new Date().toISOString(),
      platform: "linux",
    });
  }
  return services.sort((a, b) => a.service.localeCompare(b.service));
}

async function listLaunchdServices() {
  // Note: `launchctl list` returns lines: PID\tStatus\tLabel
  // Status 0 means OK; PID may be "-" for not running.
  // This enumerates user space. System space typically needs sudo (`launchctl print system` parsing is messy).
  const { stdout } = await execCmd("launchctl list || true");
  const lines = stdout.split("\n").slice(1); // skip header if present
  const services = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    // Try to parse: PID, Status, Label
    const label = parts[parts.length - 1];
    if (!label) continue;

    const pidRaw = parts[0];
    const statusRaw = parts[1];
    const running = pidRaw && pidRaw !== "-" && /^\d+$/.test(pidRaw);
    const statusNum = Number(statusRaw);
    const healthy = running && (isNaN(statusNum) || statusNum === 0);

    // filters
    if (config.include.length && !config.include.includes(label)) continue;
    if (config.exclude.includes(label)) continue;

    services.push({
      id: mkId(`${label}`),
      host: HOSTNAME,
      service: label,
      systemId: SYSTEM_ID,
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
  const { stdout, err } = await execCmd(
    `${config.docker.binary} ps --format "{{.ID}}|{{.Names}}|{{.Status}}"`
  );
  if (err) return [];
  const lines = stdout.trim().split("\n").filter(Boolean);
  return lines.map((l) => {
    const [id, name, status] = l.split("|");
    return {
      id: mkId(`docker:${name}`),
      host: HOSTNAME,
      systemId: SYSTEM_ID,
      service: `docker:${name}`,
      description: `Container ${id}`,
      load: "loaded",
      active: /Up\s/i.test(status) ? "active" : "inactive",
      sub: status,
      unitFileState: "container",
      path: "",
      healthy: /Up\s/i.test(status),
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

// ---------- Push to central ----------
async function pushSnapshot() {
  if (!config.push.enabled || !config.push.url) return;
  const payload = {
    host: HOSTNAME,
    systemId: SYSTEM_ID,
    takenAt: lastSnapshot.takenAt || new Date().toISOString(),
    services: lastSnapshot.services,
    agent: {
      version: "1.0.0",
      platform: process.platform,
      node: process.version,
    },
  };

  const data = Buffer.from(JSON.stringify(payload));
  const u = new URL(config.push.url);

  const opts = {
    hostname: u.hostname,
    port: u.port || (u.protocol === "https:" ? 443 : 80),
    path: u.pathname + (u.search || ""),
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": data.length,
    },
  };
// console.log("[svc-agent] Pushing snapshot to", JSON.stringify(opts));
  if (config.push.token) {
    opts.headers.authorization = `Bearer ${config.push.token}`;
  }

  const useHttps = u.protocol === "https:";
  const client = useHttps ? require("https") : require("http");

  await new Promise((resolve) => {
    const req = client.request(opts, (res) => {
      // Drain
      res.on("data", () => {});
      res.on("end", resolve);
    });
    req.on("error", resolve);
    req.write(data);
    req.end();
  });
}

// ---------- HTTP API ----------
const app = express();
app.use(express.json());

const collectDefaultMetrics = prom.collectDefaultMetrics;
collectDefaultMetrics();

const gaugeServiceHealthy = new prom.Gauge({
  name: "tds_service_healthy",
  help: "1 if the service is healthy, else 0",
  labelNames: ["host", "service", "platform"],
});

const gaugeServicesCount = new prom.Gauge({
  name: "tds_services_count",
  help: "Number of services reported",
  labelNames: ["host"],
});

function updateMetrics(snapshot) {
  gaugeServicesCount.set({ host: HOSTNAME }, snapshot.services.length);
  snapshot.services.forEach((s) => {
    gaugeServiceHealthy.set(
      { host: s.host, service: s.service, platform: s.platform },
      s.healthy ? 1 : 0
    );
  });
}

// Basic healthcheck
app.get("/health", async (_req, res) => {
  if (!lastSnapshot.takenAt) await takeSnapshot();
  res.json({
    ok: true,
    host: HOSTNAME,
    systemId: SYSTEM_ID,
    takenAt: lastSnapshot.takenAt,
    servicesCount: lastSnapshot.services.length,
    agent: {
      version: "1.0.0",
      platform: process.platform,
      node: process.version,
    },
  });
});

// Full services list
app.get("/services", async (_req, res) => {
  if (!lastSnapshot.takenAt) await takeSnapshot();
  res.json(lastSnapshot);
});

// Single service by id (hostname:service)
app.get("/services/:id", async (req, res) => {
  if (!lastSnapshot.takenAt) await takeSnapshot();
  const svc = lastSnapshot.services.find((s) => s.id === req.params.id);
  if (!svc) return res.status(404).json({ error: "not found" });
  res.json(svc);
});

// Force refresh now
app.post("/refresh", async (_req, res) => {
  const snap = await takeSnapshot();
  updateMetrics(snap);
  res.json({ ok: true, takenAt: snap.takenAt, services: snap.services.length });
});

// Prometheus metrics
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", prom.register.contentType);
  res.end(await prom.register.metrics());
});

(async function boot() {
    SYSTEM_ID = await initSystemId();
  
    const server = app.listen(config.port, config.bind, async () => {
      const first = await takeSnapshot();
      updateMetrics(first);
      // optional initial push
      pushSnapshot().catch(() => {});
      console.log(
        `[svc-agent] ${HOSTNAME} (${SYSTEM_ID}) on http://${config.bind}:${config.port} — ${first.services.length} services`
      );
    });
  
    // periodic refresh + push (unchanged)
    const REFRESH_MS = 30 * 1000;
    setInterval(async () => {
      const snap = await takeSnapshot();
      updateMetrics(snap);
      if (config.push.enabled) pushSnapshot().catch(() => {});
    }, REFRESH_MS);
  
    // graceful shutdown (unchanged)
    function shutdown(sig) {
      console.log(`[svc-agent] ${sig} received, shutting down`);
      server.close(() => process.exit(0));
    }
    ["SIGINT", "SIGTERM"].forEach((sig) => process.on(sig, () => shutdown(sig)));
  })();

// Graceful shutdown
function shutdown(sig) {
    console.log(`[svc-agent] ${sig} received, shutting down`);
    server.close(() => process.exit(0));
  }
  ["SIGINT", "SIGTERM"].forEach((sig) => process.on(sig, () => shutdown(sig)));