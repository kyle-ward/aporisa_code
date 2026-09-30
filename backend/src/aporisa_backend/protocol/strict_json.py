"""Strict JSON decoding (docs/protocol.md section 3.1).

Rejects duplicate keys, NaN and Infinity, and non-UTF-8 bytes. Type strictness (no
coercion, booleans are not integers) is enforced later by the JSON Schema check.
"""

from __future__ import annotations

import json
from typing import Any


class StrictJsonError(ValueError):
    """The body is not strict JSON; callers map this to invalid_request."""


def _no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise StrictJsonError("duplicate key")
        result[key] = value
    return result


def _reject_constant(_name: str) -> Any:
    raise StrictJsonError("non-finite number")


def loads(data: bytes | str) -> Any:
    try:
        text = data.decode("utf-8") if isinstance(data, bytes) else data
        return json.loads(text, object_pairs_hook=_no_duplicates, parse_constant=_reject_constant)
    except StrictJsonError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
        raise StrictJsonError("malformed JSON") from None


def dumps(value: Any) -> str:
    """Compact, finite-only JSON for events and bodies."""
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
