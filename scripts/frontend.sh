#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

MODE="${1:-help}"

usage() {
  cat <<'EOF'
Usage: ./frontend.sh <mode>
  doctor     Read-only toolchain and dependency diagnostics
  prepare    Install project-local Node and locked npm dependencies (only networked mode)
  dev        Run the app from source: Vite dev server, main/preload watch, Electron (offline)
  build      Build and package Aporisa Code.app, ad-hoc signed (offline)
  install    Copy the packaged app into ~/Applications
  uninstall  Remove the app from ~/Applications (keeps sessions and settings)
  help       Show this message
Run as the project owner, without sudo.
EOF
}

[ "$#" -le 1 ] || { aporisa_error "Invalid arguments."; usage >&2; exit 2; }
[ "$(id -u)" -ne 0 ] || { aporisa_error "Run as the project owner, without sudo."; exit 1; }
[ "$(uname -s)" = "Darwin" ] || { aporisa_error "Aporisa Code supports macOS only."; exit 1; }

APP_NAME="Aporisa Code"
RELEASE_APP="$FRONTEND_DIR/release/$APP_NAME-darwin-arm64/$APP_NAME.app"
INSTALLED_APP="$HOME/Applications/$APP_NAME.app"
DATA_DIR="$HOME/Library/Application Support/$APP_NAME"
DEV_RENDERER_URL="http://localhost:5199"

node_archive_name() {
  case "$(uname -m)" in
    arm64) printf 'node-v%s-darwin-arm64.tar.gz\n' "$APORISA_NODE_VERSION" ;;
    *) aporisa_log SYSTEM "Apple Silicon (arm64) is required."; return 1 ;;
  esac
}

doctor() {
  local failed=0
  aporisa_log INFO "Frontend doctor: $FRONTEND_DIR"
  if [ "$(uname -m)" = arm64 ]; then
    aporisa_log READY "Apple Silicon host."
  else
    aporisa_log SYSTEM "Apple Silicon (arm64) is required."
    failed=1
  fi
  if [ -x "$FRONTEND_NODE_DIR/bin/node" ] &&
    [ "$("$FRONTEND_NODE_DIR/bin/node" --version 2>/dev/null)" = "v$APORISA_NODE_VERSION" ]; then
    aporisa_log READY "Project Node v$APORISA_NODE_VERSION."
    local npm_version
    npm_version="$(PATH="$FRONTEND_NODE_DIR/bin:$PATH" "$FRONTEND_NODE_DIR/bin/npm" --version 2>/dev/null || true)"
    case "$npm_version" in
      "$APORISA_NPM_MAJOR".*) aporisa_log READY "Project npm $npm_version." ;;
      *) aporisa_log REPAIRABLE "Project npm $APORISA_NPM_MAJOR.x is missing or broken; run prepare."; failed=1 ;;
    esac
  else
    aporisa_log REPAIRABLE "Project Node v$APORISA_NODE_VERSION is missing; run prepare."
    failed=1
  fi
  if [ -f "$FRONTEND_DIR/package-lock.json" ]; then
    aporisa_log READY "package-lock.json present."
  else
    aporisa_log REPAIRABLE "package-lock.json is missing; run prepare."
    failed=1
  fi
  if [ -d "$FRONTEND_DIR/node_modules" ]; then
    aporisa_log READY "node_modules installed."
  else
    aporisa_log REPAIRABLE "node_modules is missing; run prepare."
    failed=1
  fi
  local electron_version
  electron_version="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$FRONTEND_DIR/node_modules/electron/package.json" 2>/dev/null || true)"
  if [ -n "$electron_version" ] && [ -x "$FRONTEND_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ] &&
    [ "$(sed 's/^v//' "$FRONTEND_DIR/node_modules/electron/dist/version" 2>/dev/null)" = "$electron_version" ]; then
    aporisa_log READY "Electron $electron_version binary installed."
  else
    aporisa_log REPAIRABLE "Electron binary is missing or stale; run prepare."
    failed=1
  fi
  if [ -x "$FRONTEND_NODE_DIR/bin/node" ] && [ -d "$FRONTEND_DIR/node_modules" ] &&
    "$FRONTEND_NODE_DIR/bin/node" "$FRONTEND_DIR/tools/electron-zip.ts" locate >/dev/null 2>&1; then
    aporisa_log READY "Electron release zip cached and verified (for build)."
  else
    aporisa_log REPAIRABLE "Electron release zip is missing from .cache/electron; run prepare."
    failed=1
  fi
  if [ -d "$INSTALLED_APP" ]; then
    aporisa_log INFO "Installed app: $INSTALLED_APP"
  else
    aporisa_log INFO "App not installed; build and install when ready."
  fi
  if [ "$failed" = 0 ]; then
    aporisa_log READY "Frontend doctor passed."
  else
    aporisa_log INFO "Frontend doctor found items to fix; see the tagged lines above."
  fi
  return "$failed"
}

prepare_node() {
  if [ -x "$FRONTEND_NODE_DIR/bin/node" ] &&
    [ "$("$FRONTEND_NODE_DIR/bin/node" --version 2>/dev/null)" = "v$APORISA_NODE_VERSION" ]; then
    aporisa_log READY "Project Node v$APORISA_NODE_VERSION already installed."
    return
  fi
  local archive downloads checksums expected actual staging
  archive="$(node_archive_name)"
  downloads="$FRONTEND_TOOLS_DIR/downloads"
  checksums="$downloads/node-v$APORISA_NODE_VERSION-SHASUMS256.txt"
  staging="$FRONTEND_TOOLS_DIR/node-staging"
  mkdir -p "$downloads"
  aporisa_log WAIT "Downloading Node v$APORISA_NODE_VERSION..."
  /usr/bin/curl -fsSL --retry 3 --output "$downloads/$archive" \
    "https://nodejs.org/dist/v$APORISA_NODE_VERSION/$archive"
  /usr/bin/curl -fsSL --retry 3 --output "$checksums" \
    "https://nodejs.org/dist/v$APORISA_NODE_VERSION/SHASUMS256.txt"
  expected="$(awk -v target="$archive" '$2 == target { print $1 }' "$checksums")"
  [ -n "$expected" ] || { aporisa_error "Checksum manifest does not list $archive."; exit 1; }
  actual="$(/usr/bin/shasum -a 256 "$downloads/$archive" | awk '{ print $1 }')"
  [ "$actual" = "$expected" ] || { aporisa_error "Node archive checksum mismatch."; exit 1; }
  rm -rf "$staging"
  mkdir -p "$staging"
  /usr/bin/tar -xzf "$downloads/$archive" --strip-components=1 -C "$staging"
  rm -rf "$FRONTEND_NODE_DIR"
  mv "$staging" "$FRONTEND_NODE_DIR"
  aporisa_log READY "Project Node v$APORISA_NODE_VERSION installed (checksum verified)."
}

prepare() {
  prepare_node
  use_project_node
  cd "$FRONTEND_DIR"
  if [ -f package-lock.json ]; then
    aporisa_log WAIT "Installing locked npm dependencies (npm ci)..."
    npm ci --no-audit --no-fund
  else
    aporisa_log WAIT "No lockfile yet; resolving dependencies and creating package-lock.json..."
    npm install --no-audit --no-fund
  fi
  aporisa_log READY "npm dependencies installed."
  # npm 11 does not run install scripts, so the Electron binary is fetched explicitly. Both
  # steps use the project cache and verify against electron's pinned checksums.json.
  aporisa_log WAIT "Installing the Electron binary and caching its release zip..."
  electron_config_cache="$FRONTEND_DIR/.cache/electron" node node_modules/electron/install.js
  node tools/electron-zip.ts fetch >/dev/null
  aporisa_log READY "Electron binary installed; release zip cached."
  doctor
}

require_ready() {
  use_project_node
  cd "$FRONTEND_DIR"
  [ -d node_modules ] || { aporisa_log REPAIRABLE "node_modules is missing; run prepare."; exit 1; }
  [ -x node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ] ||
    { aporisa_log REPAIRABLE "Electron binary is missing; run prepare."; exit 1; }
}

app_running() {
  /usr/bin/pgrep -f "$1/Contents/MacOS/$APP_NAME" >/dev/null 2>&1
}

DEV_PIDS=()
stop_dev_children() {
  local pid
  for pid in "${DEV_PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in "${DEV_PIDS[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
}

dev() {
  require_ready
  node tools/build-electron.ts
  trap stop_dev_children EXIT
  trap 'exit 130' INT TERM
  node tools/build-electron.ts --watch &
  DEV_PIDS+=("$!")
  node node_modules/vite/bin/vite.js --config vite.ui.config.ts --clearScreen false --logLevel warn &
  DEV_PIDS+=("$!")
  local tries=0
  until /usr/bin/curl -fsS -o /dev/null "$DEV_RENDERER_URL"; do
    tries=$((tries + 1))
    [ "$tries" -lt 60 ] || { aporisa_error "Vite dev server did not start on $DEV_RENDERER_URL."; exit 1; }
    sleep 0.5
  done
  local env_file=""
  [ -f "$FRONTEND_DIR/.env" ] && env_file="$FRONTEND_DIR/.env"
  aporisa_log READY "Renderer at $DEV_RENDERER_URL (hot reload). Main/preload changes need a restart of dev."
  APORISA_DEV=1 APORISA_RENDERER_URL="$DEV_RENDERER_URL" APORISA_ENV_FILE="$env_file" \
    node_modules/electron/dist/Electron.app/Contents/MacOS/Electron dist/app
}

build() {
  require_ready
  local zip_dir app
  zip_dir="$(node tools/electron-zip.ts locate)" || exit 1
  rm -rf dist/app
  aporisa_log WAIT "Bundling main and preload..."
  node tools/build-electron.ts
  aporisa_log WAIT "Building the renderer..."
  node node_modules/vite/bin/vite.js build --config vite.ui.config.ts --logLevel warn
  aporisa_log WAIT "Packaging $APP_NAME.app..."
  app="$(node tools/package-app.ts "$zip_dir")"
  [ "$app" = "$RELEASE_APP" ] || { aporisa_error "Unexpected package path: $app"; exit 1; }
  /usr/bin/codesign --force --deep --sign - "$app"
  /usr/bin/codesign --verify --deep --strict "$app"
  aporisa_log READY "Built and ad-hoc signed: $app"
}

install_app() {
  [ -d "$RELEASE_APP" ] || { aporisa_log REPAIRABLE "No packaged app; run ./frontend.sh build first."; exit 1; }
  if app_running "$INSTALLED_APP"; then
    aporisa_log MANUAL "$APP_NAME is running; quit it, then run install again."
    exit 1
  fi
  mkdir -p "$HOME/Applications"
  local staging="$HOME/Applications/.$APP_NAME.app.installing"
  rm -rf "$staging"
  /usr/bin/ditto "$RELEASE_APP" "$staging"
  rm -rf "$INSTALLED_APP"
  mv "$staging" "$INSTALLED_APP"
  aporisa_log READY "Installed $INSTALLED_APP"
  aporisa_log INFO "Sessions and settings live in $DATA_DIR"
}

uninstall_app() {
  if [ ! -d "$INSTALLED_APP" ]; then
    aporisa_log INFO "$APP_NAME is not installed."
    return
  fi
  if app_running "$INSTALLED_APP"; then
    aporisa_log MANUAL "$APP_NAME is running; quit it, then run uninstall again."
    exit 1
  fi
  rm -rf "$INSTALLED_APP"
  aporisa_log READY "Removed $INSTALLED_APP"
  aporisa_log INFO "Kept sessions, settings and the stored key in $DATA_DIR; delete it yourself if you want them gone."
}

case "$MODE" in
  help | -h | --help) usage ;;
  doctor) doctor ;;
  prepare) prepare ;;
  dev) dev ;;
  build) build ;;
  install) install_app ;;
  uninstall) uninstall_app ;;
  *) aporisa_error "Unsupported mode: $MODE"; usage >&2; exit 2 ;;
esac
