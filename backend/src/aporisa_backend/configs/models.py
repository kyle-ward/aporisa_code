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
    # affine4g64) plus room for activations and a working context.
    min_available_memory_gib: int = 72
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

# B1 capability set (DEVELOPMENT_PLAN.md 5.5); B0-12 confirmed parallel tool calls.
_FLASH_NEXT_CAPABILITIES = {
    "parallel_tool_calls": True,
    "custom_tools": False,
    "structured_output": False,
    "prompt_cache": True,
    "prewarm": True,
    "input_tokens": True,
    "websocket": True,
    "reasoning_effort_updates": True,
}

MODEL_LIST: tuple[str, ...] = (
    "Qwen3.8-Flash-Next-affine4g64",
    # MTP draft model converted with the same recipe; used by B2-2, never served on its own.
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
