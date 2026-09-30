"""The preparation contract shared by doctor, prepare and run; no mutations (14.6).

Tags: SYSTEM (host), MANUAL (user action: .env, sysctl, weights), REPAIRABLE (prepare fixes
it), WAIT (resources or service state right now), READY/INFO.
"""

from __future__ import annotations

import importlib.metadata
import json
import os
import platform
import shutil
import socket
import subprocess
from pathlib import Path

from ..configs.deployment import COMMAND_TIMEOUT_SECONDS, MIN_PREPARE_DISK_GIB
from ..console import emit
from .report import Report

GIB = 1024**3


def platform_check(report: Report) -> bool:
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        report.add("platform", "SYSTEM", "The backend supports only Apple silicon macOS.")
        return False
    report.add("platform", "READY", f"Platform: macOS {platform.mac_ver()[0]} (arm64).")
    return True


def configuration_check(root: Path, report: Report):
    try:
        from ..configs.settings import Settings

        settings = Settings.read(env_file=root / "backend" / ".env", root=root)
    except ImportError:
        report.add("configuration", "REPAIRABLE", "Project dependencies are missing; run prepare.")
        return None
    except (ValueError, OSError):
        report.add(
            "configuration",
            "MANUAL",
            "Check backend/.env (see backend/.env.example): a random printable APORISA_API_KEY "
            "and an optional APORISA_BACKEND_PORT (1-65535). No other keys are allowed.",
        )
        return None
    report.add("configuration", "READY", "Configuration and API key are valid; key not shown.")
    report.add("port", "INFO", f"Backend port: {settings.port} on {settings.host}.")
    return settings


def storage_check(root: Path, report: Report) -> None:
    for relative in (".runtime", ".cache", "backend/logs"):
        target = root / relative
        while not target.exists() and target != root.parent:
            target = target.parent
        if not target.is_dir() or not os.access(target, os.W_OK | os.X_OK):
            report.add(
                "storage", "MANUAL", "Project runtime, cache or log location is not writable."
            )
            return
    report.add("storage", "READY", "Project runtime, cache and log locations are writable.")


def dependency_check(root: Path, report: Report) -> bool:
    try:
        from .dependencies import verify_dependencies

        verify_dependencies(root)
    except (ImportError, ValueError, OSError, KeyError, importlib.metadata.PackageNotFoundError):
        report.add(
            "dependencies",
            "REPAIRABLE",
            "Project Python or dependencies are incomplete or stale; run prepare.",
        )
        return False
    report.add("dependencies", "READY", "Project dependencies match backend/uv.lock.")
    return True


def source_check(root: Path, report: Report) -> None:
    from .artifacts import verify_source_receipt

    try:
        verify_source_receipt(root)
    except ValueError:
        report.add(
            "source", "REPAIRABLE", "Sources or dependencies changed since prepare; run prepare."
        )
    else:
        report.add("source", "READY", "Source receipt matches the current checkout.")


def wired_limit_mb() -> int | None:
    try:
        result = subprocess.run(
            ["/usr/sbin/sysctl", "-n", "iogpu.wired_limit_mb"],
            capture_output=True,
            text=True,
            timeout=COMMAND_TIMEOUT_SECONDS,
        )
        return int(result.stdout.strip()) if result.returncode == 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def model_check(root: Path, report: Report, *, full: bool, progress: bool = False):
    """Pointer -> identity -> record -> inventory. Returns the Selection when usable."""
    from .artifacts import select, verify_assets
    from .assets import Layout

    layout = Layout(root)
    try:
        selection = select(layout)
    except ValueError:
        report.add(
            "model",
            "MANUAL",
            "The pointed identity has no unique, completed local record: check POINTERS and "
            "MODEL_LIST in configs/models.py and ./model_weights.sh list. prepare never "
            "downloads or converts weights.",
        )
        return None
    report.add(
        "model",
        "INFO",
        f"Serving alias {selection.alias} -> {selection.identity} "
        f"({selection.record['directory']}/{selection.record['version']}).",
    )
    limit = wired_limit_mb()
    if limit is None or limit < selection.profile.wired_limit_mb:
        report.add(
            "wired_limit",
            "MANUAL",
            f"iogpu.wired_limit_mb is {limit}; this model needs at least "
            f"{selection.profile.wired_limit_mb}. Set it with sudo (docs/macos.md); "
            "the backend never changes system settings.",
        )
    else:
        report.add("wired_limit", "READY", f"GPU wired memory limit: {limit} MB.")
    if progress:
        emit(
            "WAIT",
            "Verifying every model checksum (read-only)..."
            if full
            else "Checking model files against the prepare receipt (sizes, small-file hashes)...",
        )
    try:
        verify_assets(layout, selection, full=full)
    except ValueError as error:
        missing_receipt = "prepare" in str(error)
        report.add(
            "assets",
            "REPAIRABLE" if missing_receipt else "MANUAL",
            "Model assets were not verified since the last change; run prepare."
            if missing_receipt
            else "Model files do not match their record; inspect with ./model_weights.sh list "
            "and re-download or re-convert the identity.",
        )
        return None
    except OSError:
        report.add("assets", "MANUAL", "Model files cannot be read; check project storage.")
        return None
    report.add(
        "assets",
        "READY",
        "Every model checksum verified." if full else "Model files match the prepare receipt.",
    )
    return selection


def resource_check(root: Path, report: Report, settings, selection) -> None:
    """Read-only; run takes the instance lock and binds the port itself to close races."""
    import psutil

    try:
        identity = json.loads((root / ".runtime" / "service.json").read_text())
        process = psutil.Process(identity["pid"])
        if (
            process.create_time() == identity["created"]
            and identity["root"] == str(root)
            and process.pid != os.getpid()
        ):
            report.add("running", "INFO", "A managed backend is already running.")
            return
    except (OSError, ValueError, KeyError, psutil.Error):
        pass
    if selection is not None:
        available = psutil.virtual_memory().available / GIB
        need = selection.profile.min_available_memory_gib
        if available < need:
            report.add(
                "memory",
                "WAIT",
                f"Available memory is {available:.1f} GiB; startup needs {need} GiB. "
                "Close other large processes (for example other model services).",
            )
        else:
            report.add("memory", "READY", f"Available memory: {available:.1f} GiB.")
    if settings is not None:
        with socket.socket() as sock:
            sock.settimeout(1)
            if sock.connect_ex((settings.host, settings.port)) == 0:
                report.add(
                    "port",
                    "WAIT",
                    f"Port {settings.port} is in use; inspect its owner. Nothing is stopped.",
                )


def prepare_disk_check(root: Path, report: Report) -> None:
    if shutil.disk_usage(root).free < MIN_PREPARE_DISK_GIB * GIB:
        report.add("disk", "MANUAL", f"prepare needs {MIN_PREPARE_DISK_GIB} GiB free disk space.")


def inspect(
    root: Path,
    *,
    dependencies: bool = True,
    assets: bool = True,
    full_assets: bool = False,
    resources: bool = True,
    progress: bool = False,
) -> Report:
    report = Report()
    if not platform_check(report):
        return report
    settings = configuration_check(root, report)
    storage_check(root, report)
    if dependencies:
        dependency_check(root, report)
    selection = None
    if assets:
        source_check(root, report)
        selection = model_check(root, report, full=full_assets, progress=progress)
    if resources:
        try:
            resource_check(root, report, settings, selection)
        except ImportError:
            pass  # the dependency finding already says to prepare
    return report
