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
    # Session budget (KV + snapshots of all sessions), evaluated before every request (6.6, C1):
    #   available memory now + session memory now + MLX buffer cache now
    #   - activation reserve - buffer cache limit - desktop margin,
    # capped by wired limit - weights - activation reserve - safety margin. The model never
    # grows into memory the desktop is using, so snapshots cannot push macOS into compressing
    # other programs (P4: a 132K prefill compressed them at up to ~2 GiB/s).
    activation_reserve_bytes: int = 4 * GIB
    safety_margin_bytes: int = 2 * GIB
    desktop_margin_bytes: int = 4 * GIB
    # Freed MLX buffers kept for reuse. 0.5 GiB instead of local_llm's 2 GiB: on a 96 GiB
    # machine holding 67 GiB of weights, every GiB returned to macOS matters more than the
    # small reallocation cost.
    cache_limit_bytes: int = GIB // 2
    # The budget above is evaluated when a request starts; between requests the desktop can
    # grow back into the memory idle sessions hold (B2 P1: after a 125K session the idle
    # worker kept ~4.7 GB and the desktop went yellow). While idle, the worker checks the
    # kernel's memory pressure this often and drops idle sessions (LRU) while it is at warn
    # or worse; a request starting under pressure drops them first too.
    idle_pressure_check_s: float = 5.0
    # Prompt lookup (B2-3): the context's tail must match an earlier span over at least
    # lookup_min_match tokens (3: shorter tails such as "    return" recur everywhere);
    # matching compares up to lookup_max_match. After a lookup round accepts nothing, the
    # next lookup_cooldown rounds use MTP drafts instead.
    lookup_min_match: int = 3
    lookup_max_match: int = 8
    lookup_cooldown: int = 2
    ple_threads: int = 64
    # Soft RLIMIT_NOFILE the gateway and worker raise themselves to. launchd's default is 256;
    # the external PLE table alone holds 384 memmaps (128 shards x 3 tensors).
    open_files: int = 65536
    # How long the gateway waits for the worker to confirm a cancel before killing it. The
    # worker checks between prefill chunks (and while waiting for PLE prefetch); one 2048-token
    # chunk near 260K context takes ~4 s unloaded but was seen to exceed 30 s under memory
    # pressure (P4 validation), so allow 60 s before treating the engine as stuck.
    cancel_timeout_s: float = 60
    # Bounded stderr tail kept while the worker starts, for the failure message.
    startup_stderr_lines: int = 40

    def as_dict(self) -> dict:
        return asdict(self)


ENGINE = EngineConfig()
