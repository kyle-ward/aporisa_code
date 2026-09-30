#!/usr/bin/env bash
# Internal runtime entry: doctor | prepare | run. Public lifecycle: ./backend_service.sh
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
export PYTHONDONTWRITEBYTECODE=1
if [ -x "$PROJECT_ROOT/backend/.venv/bin/python" ]; then
  exec "$PROJECT_ROOT/backend/.venv/bin/python" -B "$PROJECT_ROOT/scripts/lifecycle.py" "${@:-help}"
fi
exec /usr/bin/python3 -B "$PROJECT_ROOT/scripts/lifecycle.py" "${@:-help}"
