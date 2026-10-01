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
    # A stateless HTTP request resends its whole history, images included (B2-6 decision 2:
    # 16 MiB held only ~5-10 screenshots). The worker frame limit (ipc/frames.py) is above it.
    max_body_bytes: int = 64 * MIB
    upload_timeout_s: float = 60
    max_http_tasks: int = 32
    max_output_bytes: int = 4 * MIB
    sse_keepalive_s: float = 15
    ws_lifetime_s: float = 3600
    ws_max_message_bytes: int = 64 * MIB
    # input_image parts per request, history and tool outputs included (protocol 11).
    max_images: int = 64
    # Largest source image the worker decodes (width x height before resizing; ~8K x 8K).
    max_image_source_pixels: int = 64 * MIB
    retry_after_s: int = 5
    shutdown_drain_s: float = 30
    # The worker spends up to shutdown_spill_s (configs/engine.py, 30 s) writing sessions
    # to the SSD cache before it exits.
    worker_stop_s: float = 45
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
