#!/usr/bin/env bash

# TDS Service Health Agent installer (Linux systemd + macOS launchd)
# Usage (branch):
#   curl -fsSL https://raw.githubusercontent.com/thomasdye12/tds-svc-agent/main/scripts/install.sh | bash
#   (with overrides) OWNER=thomasdye12 REPO=tds-svc-agent BRANCH=main AUTO_NODE=true bash
#
# Usage (tagged release zip):
#   curl -fsSL https://raw.githubusercontent.com/thomasdye12/tds-svc-agent/main/scripts/install.sh | VERSION=v1.0.0 bash
set -euo pipefail

OWNER="${OWNER:-thomasdye12}"
REPO="${REPO:-tds-svc-agent}"
# VERSION=latest uses BRANCH (default main). If VERSION!=latest we fetch the tag.
VERSION="${VERSION:-latest}"
BRANCH="${BRANCH:-main}"

INSTALL_DIR_LINUX="/opt/tds-svc-agent"
INSTALL_DIR_MAC="/usr/local/tds-svc-agent"
SERVICE_NAME="tds-svc-agent"

PORT_DEFAULT="${PORT_DEFAULT:-5668}"
BIND_DEFAULT="${BIND_DEFAULT:-127.0.0.1}"
CREATE_CONFIG="${CREATE_CONFIG:-true}"
AUTO_NODE="${AUTO_NODE:-false}"

need() { command -v "$1" >/dev/null 2>&1; }
err() { echo "ERROR: $*" >&2; exit 1; }

detect_os() {
  case "$(uname -s)" in
    Linux) echo "linux" ;;
    Darwin) echo "macos" ;;
    *) err "Unsupported OS: $(uname -s)" ;;
  esac
}

download() {
  local url="$1" dest="$2"
  if need curl; then
    curl -fsSL "$url" -o "$dest"
  elif need wget; then
    wget -q "$url" -O "$dest"
  else
    err "Need curl or wget to download."
  fi
}

ensure_node() {
  if need node && need npm; then return; fi
  if [ "$AUTO_NODE" = "true" ]; then
    echo "[*] Node/npm not found. Attempting to install..."
    if [ "$OS" = "linux" ]; then
      if need apt-get; then
        sudo apt-get update -y
        sudo apt-get install -y ca-certificates curl
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
      elif need yum; then
        curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo -E bash -
        sudo yum install -y nodejs
      else
        err "No supported package manager found to auto-install Node."
      fi
    else
      if need brew; then
        brew install node@20
        brew link --overwrite --force node@20
      else
        err "Homebrew not found. Install Node manually or set AUTO_NODE=false."
      fi
    fi
  fi
  need node || err "Node.js not found. Re-run with AUTO_NODE=true or install Node 18+."
  need npm  || err "npm not found. Ensure Node/npm are installed."
}

# Fetches the repo zip to /tmp and unzips to a temp dir; outputs path on stdout
fetch_repo_zip() {
  local z="/tmp/${REPO}.zip"
  rm -f "$z"

  if [ "$VERSION" = "latest" ]; then
    ZIP_URL="https://codeload.github.com/${OWNER}/${REPO}/zip/refs/heads/${BRANCH}"
  else
    ZIP_URL="https://codeload.github.com/${OWNER}/${REPO}/zip/refs/tags/${VERSION}"
  fi

  # echo "[*] Downloading ${ZIP_URL}"
  download "$ZIP_URL" "$z" || err "Failed to download repo zip."

  local tmpdir
  tmpdir="$(mktemp -d)"
  unzip -q "$z" -d "$tmpdir"
  # The zip extracts to ${REPO}-${BRANCH} or ${REPO}-${VERSION}
  local extracted
  extracted="$(find "$tmpdir" -maxdepth 1 -type d -name "${REPO}-*" | head -n1)"
  [ -n "$extracted" ] || err "Failed to locate extracted directory."
  echo "$extracted"
}

create_default_config_linux() {
  if [ "$CREATE_CONFIG" = "true" ] && [ ! -f "/etc/${SERVICE_NAME}.json" ]; then
    cat <<JSON | sudo tee "/etc/${SERVICE_NAME}.json" >/dev/null
{
  "port": ${PORT_DEFAULT},
  "bind": "${BIND_DEFAULT}",
  "include": [],
  "exclude": ["snapd.service"],
  "push": {
    "enabled": false,
    "url": "",
    "intervalSec": 60,
    "token": ""
  },
  "docker": { "enabled": false }
}
JSON
    sudo chmod 0644 "/etc/${SERVICE_NAME}.json"
    echo "[*] Wrote /etc/${SERVICE_NAME}.json"
  fi
}

create_default_config_macos() {
  local install_dir="$1"
  if [ "$CREATE_CONFIG" = "true" ] && [ ! -f "${install_dir}/tds-svc-agent.json" ]; then
    cat <<JSON | sudo tee "${install_dir}/tds-svc-agent.json" >/dev/null
{
  "port": ${PORT_DEFAULT},
  "bind": "${BIND_DEFAULT}",
  "include": [],
  "exclude": [],
  "push": { "enabled": false, "url": "", "intervalSec": 60, "token": "" },
  "docker": { "enabled": false }
}
JSON
    sudo chmod 0644 "${install_dir}/tds-svc-agent.json"
    echo "[*] Wrote ${install_dir}/tds-svc-agent.json"
  fi
}

install_linux() {
  local src_dir="$1"
  local install_dir="$INSTALL_DIR_LINUX"

  echo "[*] Installing to ${install_dir}"
  sudo rm -rf "$install_dir"
  sudo mkdir -p "$install_dir"
  sudo cp -a "${src_dir}/." "$install_dir/"

  # Install production deps in-place (root of repo)
  pushd "$install_dir" >/dev/null
  npm ci --omit=dev || npm install --production
  popd >/dev/null

  create_default_config_linux

  # If a unit template exists, use it; otherwise generate one.
  local unit_src="${install_dir}/system/${SERVICE_NAME}.service"
  local unit_dst="/etc/systemd/system/${SERVICE_NAME}.service"

  if [ -f "$unit_src" ]; then
    sudo cp -f "$unit_src" "$unit_dst"
    # Ensure ExecStart points to root/svc-agent.js (not app/)
    sudo sed -i "s|ExecStart=.*|ExecStart=/usr/bin/node ${install_dir}/svc-agent.js|g" "$unit_dst"
    # Ensure WorkingDirectory
    if ! grep -q '^WorkingDirectory=' "$unit_dst"; then
      echo "WorkingDirectory=${install_dir}" | sudo tee -a "$unit_dst" >/dev/null
    else
      sudo sed -i "s|^WorkingDirectory=.*|WorkingDirectory=${install_dir}|g" "$unit_dst"
    fi
    # Ensure config env points to /etc
    if grep -q '^Environment=SVC_AGENT_CONFIG=' "$unit_dst"; then
      sudo sed -i "s|^Environment=SVC_AGENT_CONFIG=.*|Environment=SVC_AGENT_CONFIG=/etc/${SERVICE_NAME}.json|g" "$unit_dst"
    else
      echo "Environment=SVC_AGENT_CONFIG=/etc/${SERVICE_NAME}.json" | sudo tee -a "$unit_dst" >/dev/null
    fi
  else
    cat <<UNIT | sudo tee "$unit_dst" >/dev/null
[Unit]
Description=TDS Service Health Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node ${install_dir}/svc-agent.js
WorkingDirectory=${install_dir}
Environment=NODE_ENV=production
Environment=SVC_AGENT_CONFIG=/etc/${SERVICE_NAME}.json
Restart=always
RestartSec=2
User=nobody
Group=nogroup

[Install]
WantedBy=multi-user.target
UNIT
  fi

  sudo systemctl daemon-reload
  sudo systemctl enable --now "${SERVICE_NAME}.service"

  echo
  echo "[✓] Installed & started: ${SERVICE_NAME}"
  echo "    Status: sudo systemctl status ${SERVICE_NAME}"
  echo "    API:    http://$(hostname -f):${PORT_DEFAULT}/health"
}

install_macos() {
  local src_dir="$1"
  local install_dir="$INSTALL_DIR_MAC"

  echo "[*] Installing to ${install_dir}"
  sudo rm -rf "$install_dir"
  sudo mkdir -p "$install_dir"
  sudo cp -a "${src_dir}/." "$install_dir/"

  pushd "$install_dir" >/dev/null
  npm ci --omit=dev || npm install --production
  popd >/dev/null

  create_default_config_macos "$install_dir"

  # Use provided plist if present, else generate minimal one
  local plist_src="${install_dir}/system/net.thomasdye.tds-svc-agent.plist"
  local plist_dst="/Library/LaunchDaemons/net.thomasdye.tds-svc-agent.plist"

  if [ -f "$plist_src" ]; then
    sudo cp -f "$plist_src" "$plist_dst"
    # Update paths: ProgramArguments[0]=node, [1]=svc-agent.js
    sudo /usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 /usr/local/bin/node" "$plist_dst" 2>/dev/null || true
    sudo /usr/libexec/PlistBuddy -c "Set :ProgramArguments:1 ${install_dir}/svc-agent.js" "$plist_dst" 2>/dev/null || true
    # Ensure env var for config
    /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables dict" "$plist_dst" 2>/dev/null || true
    /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:SVC_AGENT_CONFIG string ${install_dir}/tds-svc-agent.json" "$plist_dst" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:SVC_AGENT_CONFIG ${install_dir}/tds-svc-agent.json" "$plist_dst" 2>/dev/null || true
  else
    cat <<PLIST | sudo tee "$plist_dst" >/dev/null
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>net.thomasdye.tds-svc-agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>${install_dir}/svc-agent.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>SVC_AGENT_CONFIG</key><string>${install_dir}/tds-svc-agent.json</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/var/log/tds-svc-agent.out.log</string>
  <key>StandardErrorPath</key><string>/var/log/tds-svc-agent.err.log</string>
</dict>
</plist>
PLIST
  fi

  sudo launchctl unload "$plist_dst" 2>/dev/null || true
  sudo launchctl load -w "$plist_dst"

  echo
  echo "[✓] Installed & started: ${SERVICE_NAME} (launchd)"
  echo "    Logs: sudo log show --predicate 'process == \"node\"' --style syslog --last 1h"
  echo "    API:  http://$(hostname -s):${PORT_DEFAULT}/health"
}

main() {
  OS=$(detect_os)
  ensure_node

  SRC_DIR="$(fetch_repo_zip)"

  if [ "$OS" = "linux" ]; then
    need systemctl || err "systemd/systemctl not found."
    install_linux "$SRC_DIR"
  else
    install_macos "$SRC_DIR"
  fi

  echo
  echo "[✓] Done."
}

main "$@"
