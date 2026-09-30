"""Human-facing console output: fixed tags and fixed messages, never JSON (AGENTS.md)."""

from __future__ import annotations

import sys

TAGS = ("READY", "INFO", "WAIT", "REPAIRABLE", "SYSTEM", "MANUAL", "ERROR")


def emit(tag: str, message: str) -> None:
    if tag not in TAGS:
        raise ValueError(f"unknown console tag {tag!r}")
    prefix = "ERROR:" if tag == "ERROR" else f"[{tag}]"
    stream = sys.stderr if tag in {"SYSTEM", "MANUAL", "REPAIRABLE", "ERROR"} else sys.stdout
    print(f"[Aporisa Code] {prefix} {message}", file=stream, flush=True)
