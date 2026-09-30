#!/usr/bin/env python3
"""Backend host lifecycle: stdlib-only bootstrap (ported from local_llm).

    doctor | prepare | run      (called by scripts/backend.sh; public entry: backend_service.sh)

prepare is the only mode that uses the network: it installs the pinned uv into .tools/uv,
the pinned Python into .runtime/python, and the locked dependencies into backend/.venv,
then hands over to the project Python for the full model verification and the receipts.
It never installs system packages, never downloads or converts weights.
"""

from __future__ import annotations

import fcntl
import hashlib
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend" / "src"))

from aporisa_backend.configs.deployment import (  # noqa: E402
    COMMAND_TIMEOUT_SECONDS,
    MIN_PREPARE_DISK_GIB,
    PYTHON_VERSION,
    UV_VERSION,
)
from aporisa_backend.console import emit  # noqa: E402
from aporisa_backend.lifecycle.report import CheckFailed, LifecycleParser  # noqa: E402

PYTHON = ROOT / "backend" / ".venv" / "bin" / "python"
UV_TARGET = "aarch64-apple-darwin"


def call(args, **kwargs) -> subprocess.CompletedProcess:
    kwargs.setdefault("capture_output", True)
    kwargs.setdefault("text", True)
    return subprocess.run([str(a) for a in args], check=True, cwd=ROOT, **kwargs)


def uv_environment() -> dict:
    env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "TMPDIR", "LANG", "USER")}
    env.update(
        UV_CACHE_DIR=str(ROOT / ".cache" / "uv"),
        UV_PYTHON_INSTALL_DIR=str(ROOT / ".runtime" / "python"),
        UV_PYTHON_PREFERENCE="only-managed",
        UV_NO_PROGRESS="1",
        PYTHONDONTWRITEBYTECODE="1",
    )
    return env


def bootstrap_uv() -> Path:
    binary = ROOT / ".tools" / "uv" / "uv"
    if binary.is_file():
        try:
            if call([binary, "--version"], timeout=COMMAND_TIMEOUT_SECONDS).stdout.split()[1] == (
                UV_VERSION
            ):
                return binary
        except (OSError, subprocess.SubprocessError, IndexError):
            pass
        emit("REPAIRABLE", "Replacing the project's invalid or outdated uv.")
    name = f"uv-{UV_TARGET}.tar.gz"
    base = f"https://github.com/astral-sh/uv/releases/download/{UV_VERSION}/"
    emit("WAIT", f"Downloading uv {UV_VERSION} and verifying its SHA256...")
    with tempfile.TemporaryDirectory(prefix="aporisa-uv-") as temp:
        archive = Path(temp) / name
        urllib.request.urlretrieve(base + name, archive)
        with urllib.request.urlopen(base + name + ".sha256", timeout=COMMAND_TIMEOUT_SECONDS) as r:
            expected = r.read().decode().split()[0]
        if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
            raise RuntimeError("uv archive checksum mismatch")
        with tarfile.open(archive) as tar:
            member = next(m for m in tar.getmembers() if m.name == f"uv-{UV_TARGET}/uv")
            binary.parent.mkdir(parents=True, exist_ok=True)
            with tar.extractfile(member) as source, binary.open("wb") as target:
                shutil.copyfileobj(source, target)
        binary.chmod(0o755)
    return binary


def dependencies_ready() -> bool:
    if not PYTHON.is_file():
        return False
    try:
        result = subprocess.run(
            [str(PYTHON), "-B", "-m", "aporisa_backend.lifecycle.dependencies"],
            capture_output=True,
            text=True,
            timeout=COMMAND_TIMEOUT_SECONDS,
            cwd=ROOT,
            env={**uv_environment(), "PYTHONDONTWRITEBYTECODE": "1"},
        )
        return result.returncode == 0 and result.stdout.strip() == "dependencies_ready"
    except (OSError, subprocess.TimeoutExpired):
        return False


def prepare_python() -> None:
    uv = bootstrap_uv()
    env = uv_environment()
    emit("WAIT", f"Installing Python {PYTHON_VERSION} and the locked dependencies...")
    call([uv, "python", "install", PYTHON_VERSION, "--no-bin"], env=env)
    sync = [
        uv,
        "sync",
        "--project",
        ROOT / "backend",
        "--python",
        PYTHON_VERSION,
        "--frozen",
        "--all-groups",
    ]
    call(sync, env=env)
    if not dependencies_ready():
        emit("REPAIRABLE", "Installed files do not match the lock; reinstalling once.")
        call([*sync, "--reinstall"], env=env)
        if not dependencies_ready():
            emit("MANUAL", "Dependencies still do not match backend/uv.lock after a reinstall.")
            raise CheckFailed()
    emit("READY", "Toolchain and locked dependencies are installed.")


def main() -> None:
    parser = LifecycleParser(description="Aporisa backend lifecycle (internal)")
    parser.add_argument(
        "mode", nargs="?", default="help", choices=["help", "doctor", "prepare", "run"]
    )
    mode = parser.parse_args().mode
    if mode == "help":
        emit(
            "INFO",
            "Internal entry: doctor | prepare | run. Public lifecycle: ./backend_service.sh help",
        )
        return
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        emit("SYSTEM", "The backend supports only Apple silicon macOS.")
        raise CheckFailed()
    if mode == "prepare":
        from aporisa_backend.lifecycle.service_guard import guard_service

        guard_service(ROOT, allow_idle=True)
        if shutil.disk_usage(ROOT).free < MIN_PREPARE_DISK_GIB * 1024**3:
            emit("MANUAL", f"prepare needs {MIN_PREPARE_DISK_GIB} GiB of free disk space.")
            raise CheckFailed()
        (ROOT / ".runtime").mkdir(exist_ok=True)
        with (ROOT / ".runtime" / "instance.lock").open("a+") as lock:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                emit("WAIT", "A backend or another prepare owns this project; stop it first.")
                raise CheckFailed() from None
            prepare_python()
    if not PYTHON.is_file():
        emit("REPAIRABLE", "Project Python is missing; run ./backend_service.sh prepare.")
        raise CheckFailed()
    os.execv(str(PYTHON), [str(PYTHON), "-B", "-m", "aporisa_backend.lifecycle.cli", mode])


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        emit("WAIT", "Interrupted.")
        raise SystemExit(130) from None
    except CheckFailed:
        raise SystemExit(1) from None
    except Exception:  # noqa: BLE001 - external output withheld
        emit("ERROR", "Lifecycle command failed; run ./backend_service.sh doctor for diagnostics.")
        raise SystemExit(1) from None
