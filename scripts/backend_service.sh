#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"
MODE="${1:-help}"
usage() {
  cat <<'USAGE'
Usage: ./backend_service.sh <mode>
  doctor     Read-only checks of the environment, model assets and service state
  prepare    Install the toolchain and locked dependencies, verify every model checksum;
             never downloads weights, never registers or starts the service
  install    Register an idle LaunchDaemon using prepared assets; never starts it
  start      Enable startup at boot, launch in the background, wait for readiness
  stop       Disable startup at boot and wait for the whole process tree to exit
  restart    Stop completely, then start
  status     Show registration, startup policy, process and readiness
  uninstall  Remove the stopped or idle service; models, caches and logs are kept
  help       Show this message
Run as the project owner, without sudo; privileged steps ask for sudo themselves.
Weights are maintained separately: ./model_weights.sh download|convert|list|delete
USAGE
}
[ "$#" -le 1 ] || { aporisa_error 'Invalid arguments.'; usage >&2; exit 2; }
case "$MODE" in
  help | -h | --help) usage; exit 0 ;;
  doctor | prepare | install | start | stop | restart | status | uninstall) ;;
  *) aporisa_error 'Unsupported mode.'; usage >&2; exit 2 ;;
esac
[ "$(id -u)" -ne 0 ] || { aporisa_error 'Run as the project owner, without sudo.'; exit 1; }
[ "$(uname -s)" = Darwin ] || { aporisa_error 'The backend service supports only macOS.'; exit 1; }
exec /bin/bash "$APORISA_ROOT/scripts/macos_service.sh" "$MODE"
