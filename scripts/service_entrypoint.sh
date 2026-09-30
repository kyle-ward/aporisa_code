#!/usr/bin/env bash
# launchd entry (ProgramArguments of the LaunchDaemon); never run by hand.
set -euo pipefail
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
[ "${1:-}" = backend ] && [ "$#" -eq 1 ] || { echo '[Aporisa Code] ERROR: expected backend' >&2; exit 2; }
[ "$(uname -s)" = Darwin ] && [ "$(id -u)" -ne 0 ] || {
  echo '[Aporisa Code] ERROR: the service requires macOS and a non-root user' >&2
  exit 1
}
umask 077
CONSOLE_DIR="$PROJECT_ROOT/.runtime/services/backend/logs"
mkdir -p "$CONSOLE_DIR"
CONSOLE_FILE="$CONSOLE_DIR/console_$(date +%Y%m%d_%H%M%S)_$$.log"
exec >>"$CONSOLE_FILE" 2>&1
printf '[Aporisa Code] [INFO] System service starting; pid=%s\n' "$$"
cd "$PROJECT_ROOT"
# The daemon reads its key and port from backend/.env, never from an inherited shell.
unset APORISA_API_KEY APORISA_BACKEND_PORT
exec "$PROJECT_ROOT/scripts/backend.sh" run
