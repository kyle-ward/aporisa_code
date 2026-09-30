#!/usr/bin/env bash
# Shared helpers for Aporisa Code scripts. Source this file; do not execute it.

APORISA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
FRONTEND_DIR="$APORISA_ROOT/aporisa_code"
FRONTEND_TOOLS_DIR="$FRONTEND_DIR/.tools"
FRONTEND_NODE_DIR="$FRONTEND_TOOLS_DIR/node"

# Pinned project-local Node toolchain (Node 24 LTS with its bundled npm).
APORISA_NODE_VERSION="24.21.0"
APORISA_NPM_MAJOR="11"

aporisa_log() {
  local label="$1"
  shift
  printf '[Aporisa Code] [%s] %s\n' "$label" "$*"
}

aporisa_error() {
  printf '[Aporisa Code] ERROR: %s\n' "$*" >&2
}

# Put the project-local Node first on PATH; never fall back to a global Node.
use_project_node() {
  if [ ! -x "$FRONTEND_NODE_DIR/bin/node" ]; then
    aporisa_log REPAIRABLE "Project-local Node is missing; run ./frontend.sh prepare."
    return 1
  fi
  export PATH="$FRONTEND_NODE_DIR/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  export npm_config_update_notifier=false
  export npm_config_fund=false
  export npm_config_audit=false
}
