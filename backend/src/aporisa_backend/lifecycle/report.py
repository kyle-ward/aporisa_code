"""Classified check results shared by doctor, prepare and run (ported from local_llm)."""

from __future__ import annotations

import argparse
import sys
from collections import Counter
from dataclasses import dataclass, field

from ..console import emit

BLOCKING = {"SYSTEM", "MANUAL", "REPAIRABLE", "WAIT"}


@dataclass(frozen=True)
class Finding:
    code: str
    tag: str
    message: str


@dataclass
class Report:
    findings: list[Finding] = field(default_factory=list)

    def add(self, code: str, tag: str, message: str) -> None:
        self.findings.append(Finding(code, tag, message))

    @property
    def ready(self) -> bool:
        return not any(f.tag in BLOCKING for f in self.findings)

    @property
    def blockers(self) -> bool:
        """Problems prepare cannot repair."""
        return any(f.tag in {"SYSTEM", "MANUAL", "WAIT"} for f in self.findings)

    def codes(self, tag: str | None = None) -> set[str]:
        return {f.code for f in self.findings if tag is None or f.tag == tag}

    def display(self, *, complete: bool = True) -> None:
        for item in self.findings:
            emit(item.tag, item.message)
        counts = Counter(f.tag for f in self.findings)
        emit(
            "INFO",
            "Check summary: "
            + " ".join(
                f"{name}={counts[tag]}"
                for name, tag in (
                    ("system", "SYSTEM"),
                    ("manual", "MANUAL"),
                    ("repairable", "REPAIRABLE"),
                    ("transient", "WAIT"),
                )
            ),
        )
        if self.ready and complete:
            emit("READY", "Environment and model assets are prepared.")
        elif counts["SYSTEM"] or counts["MANUAL"]:
            emit("INFO", "Resolve the system/manual issues above; prepare cannot repair them.")
        elif counts["WAIT"]:
            emit("INFO", "Current resources or service state prevent this; resolve WAIT first.")
        elif counts["REPAIRABLE"]:
            emit("INFO", "Preparation required: run ./backend_service.sh prepare.")


class CheckFailed(Exception):
    """A displayed report already holds the actionable explanation."""


def require_ready(report: Report, *, complete: bool = True) -> None:
    report.display(complete=complete)
    if not report.ready:
        raise CheckFailed()


class LifecycleParser(argparse.ArgumentParser):
    def error(self, message):
        # argparse echoes arbitrary arguments; keep errors fixed.
        emit("ERROR", "Invalid command or arguments. Use help to list supported modes.")
        self.print_usage(sys.stderr)
        raise SystemExit(2)
