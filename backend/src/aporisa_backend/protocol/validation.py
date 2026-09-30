"""Semantic request checks (docs/protocol.md sections 5-8 and 6.1).

A port of aporisa_code/src/protocol/validation.ts and the schema-subset rules of tools.ts,
so the backend rejects exactly what the SDK refuses to send. Shape is checked first by
schema.check; these rules depend on the model or span several fields.
"""

from __future__ import annotations

from typing import Any

from .errors import ProtocolError

SCHEMA_TYPES = {"object", "array", "string", "number", "integer", "boolean", "null"}
ALLOWED_KEYWORDS = {
    "type",
    "properties",
    "required",
    "items",
    "enum",
    "description",
    "additionalProperties",
    "anyOf",
}
MAX_SCHEMA_DEPTH = 12


def _fail(code: str, param: str | None, message: str) -> ProtocolError:
    return ProtocolError(code, message, param)


def schema_subset_violation(schema: Any) -> str | None:
    """None when `schema` stays inside the portable subset (section 8.3), else a reason."""
    if not isinstance(schema, dict) or schema.get("type") != "object":
        return "root schema must be an object schema"
    return _visit(schema, 0, True)


def _visit(node: Any, depth: int, is_root: bool) -> str | None:
    if depth > MAX_SCHEMA_DEPTH:
        return "schema is nested too deeply"
    if not isinstance(node, dict):
        return "every schema node must be an object"
    for key in node:
        if key not in ALLOWED_KEYWORDS:
            return f"keyword '{key}' is not supported"
    if "anyOf" in node:
        if is_root:
            return "anyOf is not allowed at the root"
        branches = node["anyOf"]
        if not isinstance(branches, list) or not branches:
            return "anyOf must be a non-empty array"
        if any(key not in ("anyOf", "description") for key in node):
            return "anyOf cannot be mixed with other keywords"
        for branch in branches:
            if violation := _visit(branch, depth + 1, False):
                return violation
        return None
    kind = node.get("type")
    if not isinstance(kind, str) or kind not in SCHEMA_TYPES:
        return "type must be a single supported type"
    if "description" in node and not isinstance(node["description"], str):
        return "description must be a string"
    if "enum" in node:
        values = node["enum"]
        if not isinstance(values, list) or not values:
            return "enum must be a non-empty array"
        if not all(v is None or isinstance(v, (str, int, float, bool)) for v in values):
            return "enum values must be scalars"
    if kind == "object":
        properties = node.get("properties", {})
        if not isinstance(properties, dict):
            return "properties must be an object"
        for child in properties.values():
            if violation := _visit(child, depth + 1, False):
                return violation
        if "required" in node:
            required = node["required"]
            if not isinstance(required, list) or not all(
                isinstance(name, str) and name in properties for name in required
            ):
                return "required must list declared properties"
        if "additionalProperties" in node and not isinstance(node["additionalProperties"], bool):
            return "additionalProperties must be a boolean"
    else:
        for key in ("properties", "required", "additionalProperties"):
            if key in node:
                return f"'{key}' is only valid on object schemas"
    if kind == "array":
        if "items" not in node:
            return "array schemas must declare items"
        return _visit(node["items"], depth + 1, False)
    if "items" in node:
        return "'items' is only valid on array schemas"
    return None


def request_violation(params: dict, model: dict) -> None:
    """Raises ProtocolError for a transport-independent request that `model` cannot serve."""
    caps = model["capabilities"]
    if params.get("parallel_tool_calls") is True and not caps["parallel_tool_calls"]:
        raise _fail(
            "unsupported_parameter", "parallel_tool_calls", "Parallel tool calls are not supported."
        )
    if "text" in params and not caps["structured_output"]:
        raise _fail("unsupported_parameter", "text", "Structured output is not supported.")
    if params.get("generate") is False and not caps["prewarm"]:
        raise _fail("unsupported_parameter", "generate", "Prewarm is not supported.")
    reasoning = params.get("reasoning")
    if reasoning is not None:
        if reasoning["effort"] not in model["reasoning"]["supported_efforts"]:
            raise _fail(
                "unsupported_parameter", "reasoning.effort", "Reasoning effort is not supported."
            )
        if "summary" in reasoning and not model["reasoning"]["summary"]:
            raise _fail(
                "unsupported_parameter",
                "reasoning.summary",
                "Reasoning summaries are not supported.",
            )
    limit = params.get("max_output_tokens")
    if limit is not None and limit > model["max_output_tokens"]:
        raise _fail(
            "invalid_request", "max_output_tokens", "max_output_tokens exceeds the model limit."
        )

    names: set[str] = set()
    for index, tool in enumerate(params.get("tools", [])):
        if tool["name"] in names:
            raise _fail("invalid_request", f"tools[{index}].name", "Tool names must be unique.")
        names.add(tool["name"])
        if tool["type"] == "custom" and not caps["custom_tools"]:
            raise _fail(
                "unsupported_parameter", f"tools[{index}]", "Custom tools are not supported."
            )
        strict = tool["type"] == "function" and tool.get("strict") is True
        if strict and not caps["structured_output"]:
            raise _fail(
                "unsupported_parameter", f"tools[{index}].strict", "Strict tools are not supported."
            )
        if tool["type"] == "function" and (reason := schema_subset_violation(tool["parameters"])):
            raise _fail(
                "unsupported_schema", f"tools[{index}].parameters", f"Unsupported schema: {reason}."
            )
    if "text" in params and (reason := schema_subset_violation(params["text"]["format"]["schema"])):
        raise _fail("unsupported_schema", "text.format.schema", f"Unsupported schema: {reason}.")
    input_violation(params["input"], model)


def input_violation(items: list[dict], model: dict) -> None:
    """Role/content rules, call/output pairing and configuration_update rules (6, 6.1, 7.1)."""
    caps = model["capabilities"]
    images = "image" in model["input_modalities"]
    open_calls: dict[str, str] = {}
    seen_calls: set[str] = set()
    for index, item in enumerate(items):
        param = f"input[{index}]"
        kind = item["type"]
        if kind == "message":
            for part in item["content"]:
                if item["role"] == "assistant":
                    allowed = part["type"] == "output_text"
                else:
                    allowed = part["type"] == "input_text" or (
                        part["type"] == "input_image" and item["role"] == "user"
                    )
                if not allowed:
                    raise _fail(
                        "invalid_request", param, "Content part is not allowed for this role."
                    )
                if part["type"] == "input_image" and not images:
                    raise _fail("unsupported_parameter", param, "Image input is not supported.")
            if "phase" in item and item["role"] != "assistant":
                raise _fail(
                    "invalid_request",
                    f"{param}.phase",
                    "phase is only valid on assistant messages.",
                )
        elif kind in ("function_call", "custom_tool_call"):
            if kind == "custom_tool_call" and not caps["custom_tools"]:
                raise _fail("unsupported_parameter", param, "Custom tools are not supported.")
            if item["call_id"] in seen_calls:
                raise _fail("invalid_request", f"{param}.call_id", "call_id must be unique.")
            seen_calls.add(item["call_id"])
            open_calls[item["call_id"]] = kind
        elif kind in ("function_call_output", "custom_tool_call_output"):
            expected = "function_call" if kind == "function_call_output" else "custom_tool_call"
            if open_calls.get(item["call_id"]) != expected:
                raise _fail(
                    "invalid_request",
                    f"{param}.call_id",
                    "Tool output does not match an earlier call.",
                )
            del open_calls[item["call_id"]]
            output = item["output"]
            if (
                isinstance(output, list)
                and any(p["type"] == "input_image" for p in output)
                and not images
            ):
                raise _fail("unsupported_parameter", param, "Image input is not supported.")
        elif kind == "configuration_update":
            if not caps["reasoning_effort_updates"]:
                raise _fail(
                    "unsupported_parameter", param, "Reasoning effort updates are not supported."
                )
            if item["reasoning"]["effort"] not in model["reasoning"]["supported_efforts"]:
                raise _fail(
                    "unsupported_parameter",
                    f"{param}.reasoning.effort",
                    "Reasoning effort is not supported.",
                )
            if open_calls:
                raise _fail(
                    "invalid_request",
                    param,
                    "A configuration update cannot precede pending tool outputs.",
                )
    if open_calls:
        raise _fail("invalid_request", "input", "Every tool call needs exactly one later output.")


def effective_effort(params: dict, model: dict) -> str:
    """Section 6.1: last configuration_update, else the request baseline, else the default."""
    for item in reversed(params["input"]):
        if item["type"] == "configuration_update":
            return item["reasoning"]["effort"]
    reasoning = params.get("reasoning")
    return reasoning["effort"] if reasoning else model["reasoning"]["default_effort"]
