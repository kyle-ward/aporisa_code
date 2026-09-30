"""Serves the gateway with the real worker on a model directory, before the lifecycle exists.

    APORISA_API_KEY=... backend/.venv/bin/python -m aporisa_backend.dev_serve --model-dir DIR

Development tool for B1 P2 real-model checks: loopback only, foreground, console events,
no file logs. The API key and port come from the process environment or backend/.env, as
for the service. It skips the P3 checks (asset records, SHA256, wired-limit sysctl), so it
must not be used as the deployment path; `backend_service.sh` replaces it.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import uvicorn

from .configs.limits import LIMITS
from .configs.models import PROFILES, active_pointer, public_model
from .configs.settings import Settings, valid_key
from .console import emit
from .gateway.app import create_app
from .gateway.process_worker import ProcessWorker
from .gateway.runtime import Runtime
from .logging_config import setup_logging


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model-dir", required=True, type=Path)
    args = parser.parse_args()
    model_dir = args.model_dir.resolve()
    if not (model_dir / "config.json").is_file():
        emit("MANUAL", f"Not a model directory: {model_dir}")
        return 1
    settings = Settings.read(require_key=False)
    if not valid_key(settings.api_key):
        emit("MANUAL", "Set APORISA_API_KEY (environment or backend/.env) to a random secret.")
        return 1
    alias, identity = active_pointer()
    profile = PROFILES[identity]
    model = public_model(alias, profile)
    runtime = Runtime(
        alias,
        profile,
        lambda: ProcessWorker(model_dir, model, profile, stop_timeout_s=LIMITS.worker_stop_s),
        LIMITS,
    )
    setup_logging(None)
    emit(
        "WAIT",
        f"Serving {alias} on http://{settings.host}:{settings.port} once the worker is ready.",
    )
    uvicorn.run(
        create_app(runtime, settings.api_key, LIMITS),
        host=settings.host,
        port=settings.port,
        ws="websockets-sansio",
        lifespan="on",
        log_level="warning",
        access_log=False,
        server_header=False,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
