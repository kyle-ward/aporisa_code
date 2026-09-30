"""WebSocket incremental continuation (docs/protocol.md section 3.3).

A port of aporisa_code/src/protocol/continuation.ts for the server side: the gateway keeps
the last completed response's full request and output per connection and expands an
incremental create into the equivalent full request itself.
"""

from __future__ import annotations

import json

# Every request field except input, client_metadata and generate must match.
CONTINUATION_KEYS = (
    "model",
    "instructions",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "reasoning",
    "text",
    "max_output_tokens",
    "prompt_cache_key",
)


def _canonical(value) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def same_properties(previous: dict, current: dict) -> bool:
    pick = lambda params: {k: params[k] for k in CONTINUATION_KEYS if k in params}  # noqa: E731
    return _canonical(pick(previous)) == _canonical(pick(current))


def expand_continuation(previous_params: dict, previous_output: list[dict], params: dict) -> dict:
    """The full request an incremental create stands for."""
    return {**params, "input": [*previous_params["input"], *previous_output, *params["input"]]}
