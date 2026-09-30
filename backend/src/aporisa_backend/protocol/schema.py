"""Shape validation against the committed machine-readable contract.

The zod types in aporisa_code/src/protocol are the single source; their JSON Schema export
lives in docs/schema/ and is what the backend validates against, so the two sides cannot
drift. Unknown keys map to unsupported_parameter, every other mismatch to invalid_request.
"""

from __future__ import annotations

import json
from collections import defaultdict
from functools import cache
from pathlib import Path

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

from .errors import ProtocolError

SCHEMA_PATH = (
    Path(__file__).resolve().parents[4] / "docs" / "schema" / "aporisa-protocol-v0.schema.json"
)
INVALID = "The request does not match the protocol."
UNKNOWN_KEY = "The request contains an unsupported parameter."


@cache
def _definitions() -> dict:
    return json.loads(SCHEMA_PATH.read_text())["$defs"]


@cache
def _validator(name: str) -> Draft202012Validator:
    return Draft202012Validator(_definitions()[name])


def definition(name: str) -> dict:
    return _definitions()[name]


def _path(parts) -> str | None:
    text = ""
    for part in parts:
        text += f"[{part}]" if isinstance(part, int) else (f".{part}" if text else str(part))
    return text or None


def _discriminated(error: ValidationError) -> ValidationError:
    """Follows anyOf/oneOf into the branch whose `type` discriminator matched, like zod."""
    while error.validator in ("anyOf", "oneOf") and error.context:
        branches = defaultdict(list)
        for child in error.context:
            branches[child.relative_schema_path[0]].append(child)
        matching = [
            children
            for children in branches.values()
            if not any(
                c.validator == "const" and list(c.relative_path) == ["type"] for c in children
            )
        ]
        if len(matching) != 1:
            break
        children = matching[0]
        preferred = [c for c in children if c.validator == "additionalProperties"] or [
            c for c in children if c.validator in ("anyOf", "oneOf")
        ]
        error = preferred[0] if preferred else max(children, key=lambda c: len(c.relative_path))
    return error


def check(name: str, value: object) -> None:
    """Raises ProtocolError when `value` does not match `$defs[name]`."""
    errors = list(_validator(name).iter_errors(value))
    if not errors:
        return
    resolved = [_discriminated(error) for error in errors]
    for error in resolved:
        if error.validator == "additionalProperties":
            extra = sorted(set(error.instance) - set(error.schema.get("properties", {})))
            param = _path([*error.absolute_path, extra[0]]) if extra else _path(error.absolute_path)
            raise ProtocolError("unsupported_parameter", UNKNOWN_KEY, param)
    first = min(resolved, key=lambda e: len(e.absolute_path))
    raise ProtocolError("invalid_request", INVALID, _path(first.absolute_path))
