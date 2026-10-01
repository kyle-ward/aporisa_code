"""Structured output values (docs/protocol.md 8.3, 8.4).

The same reading as the frontend's schemaValueViolation: objects are closed unless their
schema says `additionalProperties: true`, and `required` properties must all be present.
Schemas are already known to stay inside the portable subset (request validation).
"""

from __future__ import annotations

import math


def value_violation(value, schema, path: str = "$") -> str | None:
    """None when `value` conforms to `schema`, otherwise a short reason naming the path."""
    if not isinstance(schema, dict):
        return f"{path}: schema is not an object"
    if isinstance(schema.get("anyOf"), list):
        if any(value_violation(value, branch, path) is None for branch in schema["anyOf"]):
            return None
        return f"{path}: matches no anyOf branch"
    if isinstance(schema.get("enum"), list) and not any(
        _same(value, option) for option in schema["enum"]
    ):
        return f"{path}: not one of the enum values"
    kind = schema.get("type")
    if kind == "null":
        return None if value is None else f"{path}: expected null"
    if kind == "boolean":
        return None if isinstance(value, bool) else f"{path}: expected a boolean"
    if kind == "string":
        return None if isinstance(value, str) else f"{path}: expected a string"
    if kind == "number":
        ok = isinstance(value, int | float) and not isinstance(value, bool)
        return None if ok and math.isfinite(value) else f"{path}: expected a number"
    if kind == "integer":
        ok = isinstance(value, int) and not isinstance(value, bool)
        ok = ok or (isinstance(value, float) and value.is_integer())
        return None if ok else f"{path}: expected an integer"
    if kind == "array":
        if not isinstance(value, list):
            return f"{path}: expected an array"
        for index, element in enumerate(value):
            violation = value_violation(element, schema.get("items"), f"{path}[{index}]")
            if violation:
                return violation
        return None
    if kind == "object":
        if not isinstance(value, dict):
            return f"{path}: expected an object"
        properties = schema.get("properties") or {}
        for name in schema.get("required") or []:
            if name not in value:
                return f"{path}: missing {name!r}"
        for name, element in value.items():
            if name in properties:
                violation = value_violation(element, properties[name], f"{path}.{name}")
                if violation:
                    return violation
            elif schema.get("additionalProperties") is not True:
                return f"{path}: unexpected property {name!r}"
        return None
    return f"{path}: unsupported schema type"


def _same(value, option) -> bool:
    # JSON equality: True is not 1, 1 is 1.0
    if isinstance(value, bool) or isinstance(option, bool):
        return type(value) is type(option) and value == option
    return value == option


def closed(schema):
    """A copy of `schema` whose objects state `additionalProperties: false` unless they say
    true: what a JSON Schema constraint engine needs to follow the 8.4 reading."""
    if isinstance(schema, list):
        return [closed(item) for item in schema]
    if not isinstance(schema, dict):
        return schema
    result = {key: closed(value) for key, value in schema.items() if key != "description"}
    if "properties" in schema:
        result["properties"] = {name: closed(child) for name, child in schema["properties"].items()}
    if schema.get("type") == "object" and schema.get("additionalProperties") is not True:
        result["additionalProperties"] = False
    return result


def instance(schema):
    """A deterministic value satisfying `schema`: the same one the frontend mock outputs
    (schemaInstance), so the fake worker and the mock answer alike."""
    if not isinstance(schema, dict):
        return None
    if isinstance(schema.get("anyOf"), list) and schema["anyOf"]:
        return instance(schema["anyOf"][0])
    if isinstance(schema.get("enum"), list) and schema["enum"]:
        return schema["enum"][0]
    kind = schema.get("type")
    if kind == "boolean":
        return True
    if kind == "string":
        return "text"
    if kind == "number":
        return 1.5
    if kind == "integer":
        return 1
    if kind == "array":
        return [instance(schema.get("items"))]
    if kind == "object":
        return {name: instance(child) for name, child in (schema.get("properties") or {}).items()}
    return None
