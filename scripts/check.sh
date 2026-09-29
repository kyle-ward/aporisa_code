#!/usr/bin/env bash
set -euo pipefail
# Deterministic CI entry. Never touches the network, loads models or starts real services.
# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

SCOPE="${1:-all}"
[ "$#" -le 1 ] || { aporisa_error "Usage: scripts/check.sh [frontend|backend]"; exit 2; }
case "$SCOPE" in
  all | frontend | backend) ;;
  *) aporisa_error "Usage: scripts/check.sh [frontend|backend]"; exit 2 ;;
esac

check_shell() {
  local script
  for script in "$APORISA_ROOT"/*.sh "$APORISA_ROOT"/scripts/*.sh; do
    [ -e "$script" ] || continue
    bash -n "$script"
  done
  aporisa_log READY "Shell syntax checks passed."
}

check_frontend() {
  use_project_node || exit 1
  [ -d "$FRONTEND_DIR/node_modules" ] || {
    aporisa_log REPAIRABLE "Frontend dependencies are missing; run ./frontend.sh prepare."
    exit 1
  }
  cd "$FRONTEND_DIR"
  aporisa_log INFO "Frontend: type check"
  npm run --silent typecheck
  aporisa_log INFO "Frontend: import boundaries"
  npm run --silent boundaries
  aporisa_log INFO "Frontend: tests"
  npm run --silent test
  aporisa_log READY "Frontend checks passed."
}

check_backend() {
  if [ ! -f "$APORISA_ROOT/backend/pyproject.toml" ]; then
    aporisa_log INFO "Backend has no sources yet; backend checks skipped."
    return
  fi
  local python="$APORISA_ROOT/backend/.venv/bin/python"
  [ -x "$python" ] || {
    aporisa_log REPAIRABLE "Backend environment is missing; prepare it with the project uv first."
    exit 1
  }
  cd "$APORISA_ROOT/backend"
  export PYTHONDONTWRITEBYTECODE=1
  aporisa_log INFO "Backend: lint"
  "$python" -m ruff check --config pyproject.toml .
  if compgen -G "tests/test_*.py" >/dev/null; then
    aporisa_log INFO "Backend: tests"
    "$python" -m pytest -q
  else
    aporisa_log INFO "Backend has no tests yet; pytest skipped."
  fi
  aporisa_log READY "Backend checks passed."
}

check_shell
case "$SCOPE" in
  frontend) check_frontend ;;
  backend) check_backend ;;
  all)
    check_frontend
    check_backend
    ;;
esac
if [ -d "$APORISA_ROOT/.git" ]; then
  git -C "$APORISA_ROOT" diff --check
fi
aporisa_log READY "Deterministic checks passed for scope: $SCOPE."
