#!/usr/bin/env bash
set -euo pipefail

# Where to stage the archive
STAGE=.dist
APP_DIR=app
OUT=tds-svc-agent

rm -rf "$STAGE"
mkdir -p "$STAGE/$OUT"

# Copy app and system files
cp -a $APP_DIR "$STAGE/$OUT/"
cp -a system "$STAGE/$OUT/"
cp -a scripts/install.sh "$STAGE/$OUT/"
cp -a scripts/uninstall.sh "$STAGE/$OUT/"

# Install production dependencies into app/ so the target hosts don't build
pushd "$STAGE/$OUT/app" >/dev/null
# Use npm ci or pnpm if you prefer; npm is the safest baseline.
npm ci --omit=dev
popd >/dev/null

# Create tarball
pushd "$STAGE" >/dev/null
tar czf "${OUT}.tar.gz" "$OUT"
popd >/dev/null

echo "Created ${STAGE}/${OUT}.tar.gz"
