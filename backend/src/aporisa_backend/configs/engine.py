"""Worker engine policy (DEVELOPMENT_PLAN.md 6.6, 7, 14.5). Reviewed values, not env knobs."""

from __future__ import annotations

from dataclasses import asdict, dataclass

GIB = 1024**3


@dataclass(frozen=True)
class EngineConfig:
    # B0-5: 2048 was the fastest chunk; 4096 costs ~2.8 GiB more peak for no gain.
    prefill_chunk: int = 2048
    # B0-8: one snapshot is ~110 MiB on the real model; 16 is ~1.8 GiB (6.6, B2-5 tunes).
    max_snapshots: int = 16
    # Snapshot budget = wired limit - resident weights - activations - margin (6.6).
    activation_reserve_bytes: int = 4 * GIB
    safety_margin_bytes: int = 2 * GIB
    # Same allocator cache bound local_llm uses on the Mac.
    cache_limit_bytes: int = 2 * GIB
    ple_threads: int = 64
    # How long the gateway waits for the worker to confirm a cancel before killing it. One
    # prefill chunk at 260K context takes several seconds.
    cancel_timeout_s: float = 30
    # Bounded stderr tail kept while the worker starts, for the failure message.
    startup_stderr_lines: int = 40

    def as_dict(self) -> dict:
        return asdict(self)


ENGINE = EngineConfig()
