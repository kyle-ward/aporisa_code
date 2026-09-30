"""Service-wide resource bounds (DEVELOPMENT_PLAN.md section 8, AGENTS.md).

Every queue, body, output, stream and timer is bounded. Values are reviewed policy, not
environment knobs.
"""

from __future__ import annotations

from dataclasses import dataclass

MIB = 1024 * 1024


@dataclass(frozen=True)
class ServiceLimits:
    active_requests: int = 1
    queued_requests: int = 2
    queue_timeout_s: float = 60
    request_timeout_s: float = 1800
    idle_timeout_s: float = 180
    max_body_bytes: int = 16 * MIB
    upload_timeout_s: float = 60
    max_http_tasks: int = 32
    max_output_bytes: int = 4 * MIB
    sse_keepalive_s: float = 15
    ws_lifetime_s: float = 3600
    ws_max_message_bytes: int = 16 * MIB
    retry_after_s: int = 5
    shutdown_drain_s: float = 30
    worker_stop_s: float = 15
    worker_start_timeout_s: float = 1800
    restart_attempts: int = 2
    restart_backoff_s: float = 5
    keep_alive_s: int = 5

    def __post_init__(self):
        if self.active_requests != 1:
            raise ValueError("the worker serves one generation at a time (D-06)")
        if self.queued_requests < 0:
            raise ValueError("queued_requests must be non-negative")


LIMITS = ServiceLimits()
