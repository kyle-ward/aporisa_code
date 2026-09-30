#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PYTHON="$PROJECT_ROOT/backend/.venv/bin/python"
if [[ ! -x "$PYTHON" ]]; then
  echo '[Aporisa Code] [REPAIRABLE] Project Python is missing; run ./backend_service.sh prepare first.' >&2
  exit 1
fi
[ "$(id -u)" -ne 0 ] || { echo '[Aporisa Code] ERROR: Run as the project owner, without sudo.' >&2; exit 1; }
export PYTHONDONTWRITEBYTECODE=1
exec "$PYTHON" -B -m aporisa_backend.lifecycle.weights "$@"
