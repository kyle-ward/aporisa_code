"""Worker engine policy (DEVELOPMENT_PLAN.md 6.6, 7, 14.5). Reviewed values, not env knobs."""

from __future__ import annotations

from dataclasses import asdict, dataclass

GIB = 1024**3


@dataclass(frozen=True)
class EngineConfig:
    # (context length from which it applies, most tokens per prefill forward). B0-5: 2048
    # was the fastest chunk at a short context; 4096 costs ~2.8 GiB more peak for no gain.
    # B2-5 profile (one forward on top of a context): per token, 1024 and 2048 cost the
    # same from 64K on (1.38/1.42 ms at 67K, 1.62/1.61 at 129K, 2.00/1.96 at 222K) and 256
    # costs 2.02 at 222K, while the forward's peak above the session is 2.2/3.2, 2.6/4.1
    # and 3.5/5.7 GB (1.6 GB for 256 at 222K): a cold 222K prefill in 2048-token chunks
    # peaked 17.7 GB above the weights and wrote 1.2 GB of swap.
    prefill_chunk_schedule: tuple = ((0, 2048), (65_536, 1024), (196_608, 512))
    # A prefill is cut (for a snapshot, or the last chunk) only where both pieces keep at
    # least this many tokens: a forward costs ~90 ms at 16 tokens, ~200 at 64, ~440 at 256
    # (B2-5 profile at 34K), so a tiny piece costs about as much as hundreds of tokens.
    snapshot_min_piece: int = 256
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
    # While a request decodes at this context length or more, the buffer cache may hold
    # decode_cache_bytes instead; back to cache_limit_bytes (and emptied) when it ends. A
    # decode round's temporaries grow with the context (one-token forward peak: 0.13 GB at
    # 2K, 0.41 at 67K, 0.68 at 129K, 0.86 at 222K) and above the cap every round returns
    # them to the system and allocates them again: at 222K, two drafts decoded 24.1 tok/s
    # with 0.5 GiB and 33.2 with 2 GiB, one draft 20.7 and 28.9 (B2-5 profile; ~1 GB of
    # other memory compressed once with 2 GiB). Covered by activation_reserve_bytes.
    decode_cache_from: int = 65_536
    decode_cache_bytes: int = 2 * GIB
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
    # A match this long is a copy in progress; a shorter one drafts only when the MTP head
    # predicts the same next token (ordinary text repeats short phrases, P3.5 validation).
    lookup_trust_match: int = 6
    # SSD session cache (B2-1, P4; B2 decision 5): sessions leaving memory (budget, memory
    # pressure) and all sessions at a graceful stop are written to .runtime/kv-cache, at
    # most this much in total (least recently used checkpoints go first). A 200K-token
    # session is ~6.5 GB; blocks shared by several sessions are stored once.
    ssd_cache_bytes: int = 64 * GIB
    # Tokens per KV block on disk: a session spilled again writes only its new blocks, and a
    # request restores only from a prefix at least one block longer than memory holds.
    ssd_block_tokens: int = 2048
    # Time the worker spends writing sessions at a graceful stop, newest first; the rest are
    # dropped. Inside the gateway's worker stop timeout (configs/limits.py, 45 s).
    shutdown_spill_s: float = 30
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
