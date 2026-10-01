"""Model registry: MODEL_LIST, POINTERS and PROFILES (AGENTS.md "模型配置与权重", D-15).

- MODEL_LIST: readable identities; unreferenced entries are never validated or loaded.
- POINTERS: public alias -> identity. Public aliases live only here, never in .env.
- PROFILES: inference parameters per identity. No directories, repositories or revisions:
  those belong to the local asset record (.runtime/model-assets/).

Switching models: register or convert weights, change POINTERS (and PROFILES if needed),
then stop -> prepare -> start.
"""

from __future__ import annotations

from dataclasses import dataclass, field

CREATED = 1_790_000_000
ALIAS_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"


@dataclass(frozen=True)
class ModelProfile:
    adapter: str
    context_window: int
    max_output_tokens: int
    supported_efforts: tuple[str, ...]
    default_effort: str
    capabilities: dict[str, bool]
    wired_limit_mb: int
    # KV bytes per context token, for the snapshot budget (B0-8 measured 28,560 on affine4g64).
    kv_bytes_per_token: int = 28_560
    # Startup waits (WAIT) below this much available memory: resident weights (66.8 GiB for
    # affine4g64, plus 1.4 GiB of MTP draft model) and room for activations and a context.
    min_available_memory_gib: int = 72
    # Speculative decoding (B2-2). The draft model is a separate identity in MODEL_LIST with
    # its own local record; start verifies and leases it like the served one and fails when
    # it is missing (no silent fallback to plain decoding). draft_schedule: (context length
    # from which it applies, drafts verified per decode round), ascending from 0. B0-10's
    # "depth" was mlx-vlm's draft_block_size, i.e. drafts + 1: 2 drafts ("depth 3") won at a
    # short context. P1 profiling on affine4g64: verifying 2 tokens costs ~5 ms more than 1 at
    # any length (39/44 ms at 32K, 49/54 ms at 111K), but 3 tokens cost 54 ms at 32K and
    # ~200 ms at 111K. Decoding 128 tokens (one run each, +-15% sampling noise): at 16K one
    # draft 34.4 tok/s vs two 29.3/31.1; at 32K 29.7 vs 26.7/32.1; at 113K 26.4 vs 9.1. So
    # from 16K on a round drafts one token; below, two (B0-10's short-context winner).
    draft_identity: str | None = None
    draft_schedule: tuple[tuple[int, int], ...] = ()
    # Prompt lookup (B2-3): (context length from which it applies, most lookup drafts one
    # round verifies). Copies from the context are long when they hit, but how many tokens
    # one verify can cover cheaply depends on the model (P1: 3 tokens cost ~200 ms at 111K).
    # An empty schedule or 0 turns lookup off at that length; MTP drafts then apply.
    lookup_schedule: tuple[tuple[int, int], ...] = ()
    # (context length from which it applies, fewest tokens a round verifies through the
    # prefill path instead of the decode path; 0: never). P2 profile on affine4g64: the
    # decode path computes wider blocks as consecutive pairs, 3/8/16 tokens cost 205/572/
    # 1000 ms at 111K against 67/86/107 ms through the prefill path; below 16K the decode
    # path is 5-6 ms faster for 3-4 tokens (MTP's two-draft rounds) and even from 8 on.
    verify_prefill_schedule: tuple[tuple[int, int], ...] = ()
    # KV bytes per context token the draft model adds: its one attention layer against the
    # target's 12 (28,560 / 12). Only feeds the session estimate.
    draft_kv_bytes_per_token: int = 0
    effective_context_window_percent: int = 95
    auto_compact_token_limit: int | None = None
    truncation_policy: dict = field(default_factory=lambda: {"mode": "bytes", "limit": 10_000})
    input_modalities: tuple[str, ...] = ("text",)
    reasoning_summary: bool = False

    def __post_init__(self):
        if self.default_effort not in self.supported_efforts:
            raise ValueError("default_effort must be one of supported_efforts")
        if set(self.capabilities) != set(CAPABILITY_NAMES):
            raise ValueError("capabilities must declare exactly the protocol capability set")
        schedule = self.draft_schedule
        if (self.draft_identity is None) != (not schedule):
            raise ValueError("draft_identity and draft_schedule go together")
        if schedule and (
            schedule[0][0] != 0
            or any(a[0] >= b[0] for a, b in zip(schedule, schedule[1:], strict=False))
            or any(count < 1 for _, count in schedule)
        ):
            raise ValueError("draft_schedule starts at 0, ascends and drafts at least one")
        for name in ("lookup_schedule", "verify_prefill_schedule"):
            steps = getattr(self, name)
            if steps and (
                steps[0][0] != 0
                or any(a[0] >= b[0] for a, b in zip(steps, steps[1:], strict=False))
                or any(count < 0 for _, count in steps)
            ):
                raise ValueError(f"{name} starts at 0 and ascends")


CAPABILITY_NAMES = (
    "parallel_tool_calls",
    "custom_tools",
    "structured_output",
    "prompt_cache",
    "prewarm",
    "input_tokens",
    "websocket",
    "reasoning_effort_updates",
)

# DEVELOPMENT_PLAN.md 5.5; B0-12 confirmed parallel tool calls; B2-4 structured output.
_FLASH_NEXT_CAPABILITIES = {
    "parallel_tool_calls": True,
    "custom_tools": False,
    "structured_output": True,
    "prompt_cache": True,
    "prewarm": True,
    "input_tokens": True,
    "websocket": True,
    "reasoning_effort_updates": True,
}

MODEL_LIST: tuple[str, ...] = (
    "Qwen3.8-Flash-Next-affine4g64",
    # MTP draft model converted with the same recipe; the served profile's draft_identity,
    # never served on its own.
    "Qwen3.8-Flash-Next-affine4g64-mtp",
)

POINTERS: dict[str, str | None] = {
    "aporisa-local-v0": "Qwen3.8-Flash-Next-affine4g64",
}

PROFILES: dict[str, ModelProfile] = {
    identity: ModelProfile(
        adapter="qwen38_flash_next",
        context_window=262_144,
        max_output_tokens=32_768,
        supported_efforts=("none", "low", "medium", "high"),
        default_effort="medium",
        capabilities=dict(_FLASH_NEXT_CAPABILITIES),
        wired_limit_mb=87_040,
        draft_identity="Qwen3.8-Flash-Next-affine4g64-mtp",
        draft_schedule=((0, 2), (16_384, 1)),
        # P2 profile (code edit, ~730 copied tokens): at most 32 lookup drafts beat 16 by
        # ~12% at every length (138/129/116 tok/s at short/16K/111K context).
        lookup_schedule=((0, 32),),
        verify_prefill_schedule=((0, 8), (16_384, 3)),
        draft_kv_bytes_per_token=2_380,
    )
    for identity in ("Qwen3.8-Flash-Next-affine4g64",)
}


def active_pointer(
    pointers: dict[str, str | None] | None = None,
) -> tuple[str, str]:
    """The single enabled (alias, identity); the service serves exactly one model."""
    enabled = [(alias, ident) for alias, ident in (pointers or POINTERS).items() if ident]
    if len(enabled) != 1:
        raise ValueError("exactly one public alias must point at a model identity")
    alias, identity = enabled[0]
    if identity not in MODEL_LIST or identity not in PROFILES:
        raise ValueError("the pointed identity needs a MODEL_LIST entry and a profile")
    draft = PROFILES[identity].draft_identity
    if draft is not None and (draft not in MODEL_LIST or draft == identity):
        raise ValueError("the profile's draft identity needs its own MODEL_LIST entry")
    return alias, identity


def public_model(alias: str, profile: ModelProfile) -> dict:
    """The /v1/models entry (docs/protocol.md section 5)."""
    return {
        "id": alias,
        "object": "model",
        "created": CREATED,
        "owned_by": "local",
        "context_window": profile.context_window,
        "max_output_tokens": profile.max_output_tokens,
        "effective_context_window_percent": profile.effective_context_window_percent,
        "auto_compact_token_limit": profile.auto_compact_token_limit,
        "truncation_policy": dict(profile.truncation_policy),
        "input_modalities": list(profile.input_modalities),
        "reasoning": {
            "supported_efforts": list(profile.supported_efforts),
            "default_effort": profile.default_effort,
            "summary": profile.reasoning_summary,
        },
        "capabilities": dict(profile.capabilities),
    }
