"""Read-only launchd guards for run and prepare (ported from local_llm)."""

from __future__ import annotations

import hashlib
import os
import platform
import plistlib
import pwd
import re
import subprocess
from pathlib import Path

from ..configs.deployment import COMMAND_TIMEOUT_SECONDS, LAUNCHD_LABEL_PREFIX
from ..console import emit
from .report import CheckFailed


def service_label(root: Path) -> str:
    user = pwd.getpwuid(os.getuid()).pw_name
    digest = hashlib.sha256(str(root.resolve()).encode()).hexdigest()[:12]
    return f"{LAUNCHD_LABEL_PREFIX}.{user}.{digest}"


def _launchctl(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["/bin/launchctl", *args], capture_output=True, text=True, timeout=COMMAND_TIMEOUT_SECONDS
    )


def guard_service(root: Path, *, allow_idle: bool = False) -> None:
    """run: only as the launchd job itself or with no job registered.
    prepare (allow_idle): also with an idle registration that has never run."""
    if platform.system() != "Darwin":
        return
    try:
        if _launchctl("print", "system").returncode:
            raise OSError("launchd system domain inaccessible")
        label = service_label(root)
        result = _launchctl("print", f"system/{label}")
        if result.returncode == 113:
            return
        if result.returncode:
            raise OSError("launchd job inspection failed")
        match = re.search(r"^\s*pid = (\d+)\s*$", result.stdout, re.MULTILINE)
        if match and int(match[1]) == os.getpid():
            return
        if allow_idle and not match:
            path = Path("/Library/LaunchDaemons") / f"{label}.plist"
            if path.is_symlink():
                raise ValueError("symlinked service definition")
            definition = plistlib.loads(path.read_bytes())
            exited = re.search(
                r"last exit code = -?\d+|last terminating signal = [A-Za-z0-9]", result.stdout
            )
            if (
                not exited
                and definition.get("RunAtLoad") is False
                and definition.get("Label") == label
                and definition.get("WorkingDirectory") == str(root)
                and definition.get("UserName") == pwd.getpwuid(os.getuid()).pw_name
            ):
                return
        emit(
            "WAIT", "The backend service is active or failed; run ./backend_service.sh stop first."
        )
    except (OSError, ValueError, subprocess.TimeoutExpired, plistlib.InvalidFileException):
        emit("MANUAL", "Cannot verify the launchd service state; see ./backend_service.sh status.")
    raise CheckFailed()
