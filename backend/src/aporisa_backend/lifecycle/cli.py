"""Private lifecycle entry run with the project Python (scripts/lifecycle.py execs it).

doctor   read-only checks; model files checked against the prepare receipt (quick)
prepare  after scripts/lifecycle.py installed the toolchain and locked dependencies:
         full SHA256 of the pointed identity, then the source and assets receipts
run      the service process: quick checks, shared lease on the model directory for its
         whole life, JSONL logs, gateway plus worker; launchd or a foreground terminal
"""

from __future__ import annotations

import fcntl
import json
import os
import resource
from contextlib import contextmanager
from pathlib import Path

from ..configs.deployment import ROOT
from ..console import emit
from .report import CheckFailed, LifecycleParser, require_ready


@contextmanager
def instance_lock(root: Path):
    directory = root / ".runtime"
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "instance.lock").open("a+") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            emit("WAIT", "Another run or prepare owns this project; stop it before retrying.")
            raise CheckFailed() from None
        try:
            yield
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def doctor(root: Path) -> bool:
    from .checks import inspect

    emit("INFO", "Backend doctor (read-only)")
    report = inspect(root, progress=True)
    report.display()
    return report.ready


def prepare(root: Path) -> None:
    from .artifacts import select, verify_assets, write_assets_receipt, write_source_receipt
    from .assets import Layout, asset_lock
    from .checks import inspect
    from .service_guard import guard_service

    with instance_lock(root):
        guard_service(root, allow_idle=True)
        require_ready(inspect(root, assets=False, resources=False), complete=False)
        layout = Layout(root)
        try:
            selection = select(layout)
        except ValueError:
            emit(
                "MANUAL",
                "The pointed identity has no unique completed local weights. Check "
                "./model_weights.sh list; prepare never downloads or converts weights.",
            )
            raise CheckFailed() from None
        with asset_lock(layout, selection.record["directory"]):
            emit("WAIT", f"Verifying every checksum of {selection.identity} (read-only)...")
            try:
                verify_assets(layout, selection, full=True)
            except (ValueError, OSError):
                emit(
                    "MANUAL",
                    "Model files do not match their record; inspect ./model_weights.sh list "
                    "and re-download or re-convert the identity.",
                )
                raise CheckFailed() from None
            write_assets_receipt(layout, selection)
        write_source_receipt(root)
        require_ready(inspect(root, resources=False))
    emit("READY", "Preparation complete. Next: ./backend_service.sh install (once), then start.")


def run(root: Path) -> None:
    import psutil
    import uvicorn

    from ..configs.engine import ENGINE
    from ..configs.limits import LIMITS
    from ..configs.models import public_model
    from ..configs.settings import Settings
    from ..gateway.app import create_app
    from ..gateway.process_worker import ProcessWorker
    from ..gateway.runtime import Runtime
    from ..logging_config import setup_logging
    from ..process_limits import raise_open_files
    from .artifacts import select
    from .assets import Layout, asset_lock
    from .checks import inspect
    from .service_guard import guard_service

    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    # launchd starts daemons with 256 open files; the worker inherits the raised limit.
    raise_open_files(ENGINE.open_files)
    with instance_lock(root):
        guard_service(root)
        require_ready(inspect(root, progress=True))
        settings = Settings.read(env_file=root / "backend" / ".env", root=root)
        layout = Layout(root)
        selection = select(layout)
        # Shared lease for the whole service life: download/convert/delete of this directory
        # are refused while it is in use.
        with asset_lock(layout, selection.record["directory"]):
            setup_logging(root / "backend" / "logs")
            model = public_model(selection.alias, selection.profile)
            runtime = Runtime(
                selection.alias,
                selection.profile,
                lambda: ProcessWorker(
                    selection.directory,
                    model,
                    selection.profile,
                    stop_timeout_s=LIMITS.worker_stop_s,
                ),
                LIMITS,
            )
            app = create_app(runtime, settings.api_key, LIMITS)

            class Server(uvicorn.Server):
                def handle_exit(self, sig, frame):
                    runtime.begin_shutdown()
                    super().handle_exit(sig, frame)

            server = Server(
                uvicorn.Config(
                    app,
                    host=settings.host,
                    port=settings.port,
                    ws="websockets-sansio",
                    lifespan="on",
                    access_log=False,
                    log_config=None,
                    server_header=False,
                    proxy_headers=False,
                    workers=1,
                    timeout_keep_alive=LIMITS.keep_alive_s,
                    timeout_graceful_shutdown=int(LIMITS.shutdown_drain_s),
                )
            )
            pid_file = root / ".runtime" / "service.json"
            pid_file.write_text(
                json.dumps(
                    {
                        "pid": os.getpid(),
                        "created": psutil.Process().create_time(),
                        "root": str(root),
                    }
                )
            )
            try:
                server.run()
                if not server.started:
                    emit("ERROR", "The backend did not start; see the lifecycle events above.")
                    raise CheckFailed()
            finally:
                pid_file.unlink(missing_ok=True)


def main() -> None:
    parser = LifecycleParser(description="Aporisa backend private lifecycle entry")
    parser.add_argument("mode", choices=["doctor", "prepare", "run"])
    mode = parser.parse_args().mode
    try:
        if mode == "doctor":
            raise SystemExit(0 if doctor(ROOT) else 1)
        if mode == "prepare":
            prepare(ROOT)
        else:
            run(ROOT)
    except KeyboardInterrupt:
        raise SystemExit(130) from None
    except CheckFailed:
        raise SystemExit(1) from None
    except Exception:  # noqa: BLE001 - upstream details withheld from the console
        emit("ERROR", "Lifecycle command failed; run ./backend_service.sh doctor for diagnostics.")
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
