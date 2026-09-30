"""JSONL event log with fixed event names and a field allowlist (AGENTS.md).

Never formats record messages or exceptions: no prompts, outputs, reasoning, tool data,
keys, headers or URLs can reach a log file. Console lines use the same allowlist.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import UTC, datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path

from .console import emit

FIELDS = {
    "request_id",
    "response_id",
    "status",
    "code",
    "transport",
    "restore_path",
    "duration_ms",
    "queue_ms",
    "ttft_ms",
    "input_tokens",
    "cached_tokens",
    "prefilled_tokens",
    "output_tokens",
    "reasoning_tokens",
    "prefill_tok_s",
    "decode_tok_s",
    "mtp_accept_rate",
    "peak_memory_gb",
    "ple_bytes_read",
    "ple_lookup_ms",
    "ple_prefetch_ms",
    "snapshot_count",
    "snapshot_bytes",
    "session_bytes",
    "sys_pageins",
    "sys_pageouts",
    "sys_compressions",
    "sys_decompressions",
    "sys_swapins",
    "sys_swapouts",
    "swap_growth_bytes",
    "major_faults",
    "compressor_bytes",
    "released_cache_bytes",
    "prefill_max_chunk_ms",
    "active",
    "queued",
    "attempt",
    "exit_code",
}
# event -> (console tag, fixed message)
EVENTS = {
    "starting": ("WAIT", "Starting the backend..."),
    "worker_starting": ("WAIT", "Starting the inference worker..."),
    "worker_ready": ("READY", "Inference worker loaded and warmed up."),
    "ready": ("READY", "Backend is ready."),
    "startup_failed": ("ERROR", "Startup failed; inspect the lifecycle events above."),
    "worker_failed": ("WAIT", "Inference worker is unavailable; admission suspended."),
    "worker_restart": ("WAIT", "Attempting bounded worker recovery..."),
    "circuit_open": ("ERROR", "Worker recovery budget exhausted; inspect before restarting."),
    "stopping": ("WAIT", "Draining requests and stopping the worker..."),
    "stopped": ("READY", "Backend stopped."),
    "response_complete": ("INFO", "Response finished."),
    "response_rejected": ("INFO", "Request rejected before streaming."),
    "response_cancelled": ("INFO", "Response cancelled."),
    "log_fallback": ("MANUAL", "File logging unavailable; console logging retained."),
}
LOGGER = logging.getLogger("aporisa.events")


class SafeFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        name = record.msg if isinstance(record.msg, str) and record.msg in EVENTS else "unknown"
        data = {"time": datetime.now(UTC).isoformat(), "level": record.levelname, "event": name}
        for key in FIELDS:
            value = getattr(record, key, None)
            if isinstance(value, bool | int | float):
                data[key] = value
            elif isinstance(value, str) and key in {
                "request_id",
                "response_id",
                "status",
                "code",
                "transport",
                "restore_path",
            }:
                if len(value) <= 64 and all(c.isalnum() or c in "_-" for c in value):
                    data[key] = value
        return json.dumps(data, ensure_ascii=True, allow_nan=False)


class ConsoleFormatter(SafeFormatter):
    def format(self, record: logging.LogRecord) -> str:
        data = json.loads(super().format(record))
        tag, message = EVENTS.get(data["event"], ("INFO", "Event."))
        label = "ERROR:" if tag == "ERROR" else f"[{tag}]"
        details = " ".join(f"{k}={data[k]}" for k in sorted(FIELDS) if k in data)
        return f"[Aporisa Code] {label} {message}" + (f" {details}" if details else "")


class PrivateRotatingFileHandler(RotatingFileHandler):
    def _open(self):
        def opener(path, flags):
            return os.open(path, flags | os.O_NOFOLLOW, 0o600)

        return open(self.baseFilename, self.mode, encoding=self.encoding, opener=opener)

    def handleError(self, record):
        if not getattr(self, "fallback_reported", False):
            self.fallback_reported = True
            emit("MANUAL", EVENTS["log_fallback"][1])


def setup_logging(
    directory: Path | None, *, max_bytes: int = 20 * 1024**2, backups: int = 5
) -> Path | None:
    """Called once by the CLI run. Third-party loggers never reach a file."""
    logging.getLogger().handlers[:] = [logging.NullHandler()]
    LOGGER.handlers.clear()
    LOGGER.propagate = False
    LOGGER.setLevel(logging.INFO)
    console = logging.StreamHandler()
    console.setFormatter(ConsoleFormatter())
    LOGGER.addHandler(console)
    if directory is None:
        return None
    try:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = directory / f"aporisa_{datetime.now(UTC):%Y%m%d_%H%M%S_%f}_{os.getpid()}.jsonl"
        handler = PrivateRotatingFileHandler(
            path, maxBytes=max_bytes, backupCount=backups, encoding="utf-8"
        )
        handler.setFormatter(SafeFormatter())
        LOGGER.addHandler(handler)
        return path
    except OSError:
        LOGGER.warning("log_fallback")
        return None


def event(name: str, **fields) -> None:
    LOGGER.info(name, extra={k: v for k, v in fields.items() if k in FIELDS})
