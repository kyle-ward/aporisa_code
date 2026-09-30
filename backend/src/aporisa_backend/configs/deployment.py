"""Host lifecycle policy (DEVELOPMENT_PLAN.md 14.6). Reviewed values, not env knobs.

The launchd timeouts live in the sibling macos_service.sh so the shell service manager can
read them without Python.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]

UV_VERSION = "0.12.7"
PYTHON_VERSION = "3.12.12"
COMMAND_TIMEOUT_SECONDS = 30

# prepare downloads toolchain and dependencies (never weights); keep headroom for them.
MIN_PREPARE_DISK_GIB = 10
# Full SHA256 of the served weights, one file per worker.
HASH_WORKERS = 8

# Layout under .runtime (14.6): one directory per identity, no platform level (macOS only).
RUNTIME = ROOT / ".runtime"
MODELS = RUNTIME / "models"
ASSET_RECORDS = RUNTIME / "model-assets"
ASSET_LOCKS = RUNTIME / "model-locks"
WEIGHT_STAGING = RUNTIME / "weight-staging"
SERVICE_STATE = RUNTIME / "services" / "backend"
INSTANCE_LOCK = RUNTIME / "instance.lock"
SERVICE_PID = RUNTIME / "service.json"
SOURCE_RECEIPT = RUNTIME / "prepared-source.json"
ASSETS_RECEIPT = RUNTIME / "prepared-assets.json"
LOG_DIR = ROOT / "backend" / "logs"

LAUNCHD_LABEL_PREFIX = "com.aporisa.backend"
