#!/usr/bin/env bash
# TDS Service Health Agent installer (Linux systemd + macOS launchd)
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/thomasdye12/tds-svc-agent/main/scripts/install.sh | bash
#   (or) VERSION=v1.2.3 bash install.sh
set -euo pipefail

OWNER="${OWNER:-thomasdye12}"             # TODO: set your GitHub org/user
REPO="${REPO:-tds-svc-agent}"         # TODO: set your repository name
VERSION="${VERSION:-latest}"          # "latest" or "vX.Y.Z"
INSTALL_DIR_LINUX="/opt/tds-svc-agent"
INSTALL_DIR_MAC="/usr/local/tds-svc-agent"
SERVICE_NAME="tds-svc-agent"
PORT_DEFAULT="${PORT_DEFAULT:-5668}"  # default port if creating config
BIND_DEFAULT="${BIND_DEFAULT:-127.0.0.1}"
CREATE_CONFIG="${CREATE_CONFIG:-true}"  # create config if none exists
AUTO_NODE="${AUTO_NODE:-false}"       # try to install Node.js if missing

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
  if need node; then
    return
  fi
  if [ "$AUTO_NODE" = "true" ]; then
    echo "[*] Node not found. Attempting to install..."
    if [ "$OS" = "linux" ]; then
      if need apt-get; then
        sudo apt-get update -y
        sudo apt-get install -y ca-certificates curl
        # Install Node 20 LTS via Nodesource (broadly compatible)
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
      elif need yum; then
        curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo -E bash -
        sudo yum install -y nodejs
      else
        err "No supported package manager found to auto-install Node."
      fi
    else # macOS
      if need brew; then
        brew install node@20
        brew link --overwrite --force node@20
      else
        err "Homebrew not found. Install Node manually or set AUTO_NODE=false."
      fi
    fi
  fi
  need node || err "Node.js not found. Re-run with AUTO_NODE=true or install Node 18+."
}

install_linux() {
  local install_dir="$INSTALL_DIR_LINUX"
  local tarball="/tmp/${REPO}.tar.gz"

  sudo mkdir -p "$install_dir"
  sudo tar xzf "$tarball" -C "$install_dir" --strip-components=1

  # Create default config if not present
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

  # Install unit
  sudo cp -f "${install_dir}/system/${SERVICE_NAME}.service" "/etc/systemd/system/${SERVICE_NAME}.service"

  # Make sure ExecStart points to the right path (in case you move things)
  sudo sed -i "s|/opt/tds-svc-agent|${install_dir}|g" "/etc/systemd/system/${SERVICE_NAME}.service"

  sudo systemctl daemon-reload
  sudo systemctl enable --now "${SERVICE_NAME}.service"

  echo
  echo "[✓] Installed & started: ${SERVICE_NAME}"
  echo "    Status: sudo systemctl status ${SERVICE_NAME}"
  echo "    API:    http://$(hostname -f):${PORT_DEFAULT}/health"
}

install_macos() {
  local install_dir="$INSTALL_DIR_MAC"
  local tarball="/tmp/${REPO}.tar.gz"

  sudo mkdir -p "$install_dir"
  sudo tar xzf "$tarball" -C "$install_dir" --strip-components=1

  # Default config next to the agent (users can move to /etc if they want)
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

  # Install plist to LaunchAgents (per-user) or LaunchDaemons (system)
  local plist_src="${install_dir}/system/net.thomasdye.tds-svc-agent.plist"
  local plist_dst="/Library/LaunchDaemons/net.thomasdye.tds-svc-agent.plist"

  # Adjust plist paths
  sudo /usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 /usr/local/bin/node" "$plist_src" 2>/dev/null || true
  sudo /usr/libexec/PlistBuddy -c "Set :ProgramArguments:1 ${install_dir}/app/svc-agent.js" "$plist_src" 2>/dev/null || true
  sudo cp -f "$plist_src" "$plist_dst"

  # Load service
  sudo launchctl unload "$plist_dst" 2>/dev/null || true
  sudo launchctl load -w "$plist_dst"

  echo
  echo "[✓] Installed & started: ${SERVICE_NAME} (launchd)"
  echo "    Logs: sudo log show --predicate 'process == \"node\"' --style syslog --last 1h"
  echo "    API:  http://$(hostname -s):${PORT_DEFAULT}/health"
}

fetch_tarball() {
  local tarball="/tmp/${REPO}.tar.gz"
  rm -f "$tarball"

  if [ "$VERSION" = "latest" ]; then
    URL="https://github.com/${OWNER}/${REPO}/releases/latest/download/tds-svc-agent.tar.gz"
  else
    URL="https://github.com/${OWNER}/${REPO}/releases/download/${VERSION}/tds-svc-agent.tar.gz"
  fi

  echo "[*] Downloading ${URL}"
  download "$URL" "$tarball" || err "Failed to download release tarball."
  echo "[*] Downloaded to $tarball"
}

main() {
  OS=$(detect_os)
  [ "$OWNER" != "<OWNER>" ] || err "Set OWNER=YourGitHubUserOrOrg before running."
  ensure_node
  fetch_tarball

  if [ "$OS" = "linux" ]; then
    need systemctl || err "systemd/systemctl not found."
    install_linux
  else
    install_macos
  fi

  echo
  echo "[✓] Done."
}

main "$@"
