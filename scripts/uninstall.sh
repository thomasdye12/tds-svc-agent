#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="tds-svc-agent"
INSTALL_DIR_LINUX="/opt/tds-svc-agent"
INSTALL_DIR_MAC="/usr/local/tds-svc-agent"

detect_os() {
  case "$(uname -s)" in
    Linux) echo "linux" ;;
    Darwin) echo "macos" ;;
    *) echo "unknown" ;;
  esac
}

OS=$(detect_os)

if [ "$OS" = "linux" ]; then
  sudo systemctl disable --now "${SERVICE_NAME}.service" || true
  sudo rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
  sudo systemctl daemon-reload
  sudo rm -rf "$INSTALL_DIR_LINUX"
  # Optional: sudo rm -f "/etc/${SERVICE_NAME}.json"
  echo "[✓] Uninstalled ${SERVICE_NAME} (Linux)"
elif [ "$OS" = "macos" ]; then
  sudo launchctl unload "/Library/LaunchDaemons/net.thomasdye.tds-svc-agent.plist" 2>/dev/null || true
  sudo rm -f "/Library/LaunchDaemons/net.thomasdye.tds-svc-agent.plist"
  sudo rm -rf "$INSTALL_DIR_MAC"
  echo "[✓] Uninstalled ${SERVICE_NAME} (macOS)"
else
  echo "Unsupported OS"
  exit 1
fi
