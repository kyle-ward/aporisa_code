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
  dev        Launch the Electron app in development mode (not implemented yet)
  build      Package Aporisa Code.app offline (not implemented yet)
  install    Copy the packaged app into ~/Applications (not implemented yet)
  uninstall  Remove the app from ~/Applications (not implemented yet)
  help       Show this message
Run as the project owner, without sudo.
EOF
}

[ "$#" -le 1 ] || { aporisa_error "Invalid arguments."; usage >&2; exit 2; }
[ "$(id -u)" -ne 0 ] || { aporisa_error "Run as the project owner, without sudo."; exit 1; }
[ "$(uname -s)" = "Darwin" ] || { aporisa_error "Aporisa Code supports macOS only."; exit 1; }

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
  doctor
}

case "$MODE" in
  help | -h | --help) usage ;;
  doctor) doctor ;;
  prepare) prepare ;;
  dev | build | install | uninstall)
    aporisa_error "Mode '$MODE' is not implemented yet."
    exit 2
    ;;
  *) aporisa_error "Unsupported mode: $MODE"; usage >&2; exit 2 ;;
esac
