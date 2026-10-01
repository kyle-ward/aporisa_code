"""The Python side of the contract: strict JSON, schema error mapping, semantic rules."""

from __future__ import annotations

import pytest
from conftest import ALIAS, PROFILE, request, user

from aporisa_backend.configs.models import public_model
from aporisa_backend.protocol import schema, strict_json
from aporisa_backend.protocol.continuation import expand_continuation, same_properties
from aporisa_backend.protocol.errors import ProtocolError
from aporisa_backend.protocol.validation import (
    effective_effort,
    request_violation,
    schema_subset_violation,
)

MODEL = public_model(ALIAS, PROFILE)


def model_with(**capabilities) -> dict:
    return {**MODEL, "capabilities": {**MODEL["capabilities"], **capabilities}}


@pytest.mark.parametrize(
    "text", ['{"a":1,"a":2}', '{"a":{"b":1,"b":1}}', "NaN", '{"a":Infinity}', "{", b"\xff"]
)
def test_strict_json_rejects(text):
    with pytest.raises(strict_json.StrictJsonError):
        strict_json.loads(text)


def test_strict_json_accepts_ordinary_json():
    assert strict_json.loads('{"a":[1,-2.5e3,true,null,"x\\u00e9"]}') == {
        "a": [1, -2500.0, True, None, "xé"]
    }


def test_schema_maps_unknown_keys_to_unsupported_parameter():
    with pytest.raises(ProtocolError) as top:
        schema.check("HttpCreateRequest", {**request(), "stream": True, "temperature": 1})
    assert (top.value.code, top.value.param) == ("unsupported_parameter", "temperature")
    nested = {**request(), "stream": True, "input": [{**user("hi"), "extra": 1}]}
    with pytest.raises(ProtocolError) as inner:
        schema.check("HttpCreateRequest", nested)
    assert (inner.value.code, inner.value.param) == ("unsupported_parameter", "input[0].extra")


@pytest.mark.parametrize(
    "body",
    [
        {**request(), "stream": False},
        {**request(), "stream": True, "max_output_tokens": True},
        {
            **request(),
            "stream": True,
            "input": [{"type": "message", "role": "system", "content": []}],
        },
        {"model": ALIAS, "stream": True},
    ],
)
def test_schema_maps_other_mismatches_to_invalid_request(body):
    with pytest.raises(ProtocolError) as error:
        schema.check("HttpCreateRequest", body)
    assert error.value.code == "invalid_request"


def test_schema_subset():
    assert (
        schema_subset_violation({"type": "object", "properties": {"q": {"type": "string"}}}) is None
    )
    assert "pattern" in schema_subset_violation(
        {"type": "object", "properties": {"q": {"type": "string", "pattern": "^a"}}}
    )
    assert schema_subset_violation({"anyOf": []}) == "root schema must be an object schema"


def test_call_output_pairing_and_configuration_updates():
    call = {"type": "function_call", "call_id": "c1", "name": "lookup", "arguments": "{}"}
    output = {"type": "function_call_output", "call_id": "c1", "output": "x"}
    update = {"type": "configuration_update", "reasoning": {"effort": "low"}}
    request_violation({**request(), "input": [user("hi"), call, output, update]}, MODEL)
    with pytest.raises(ProtocolError) as pending:
        request_violation({**request(), "input": [user("hi"), call, update, output]}, MODEL)
    assert (pending.value.code, pending.value.param) == ("invalid_request", "input[2]")
    with pytest.raises(ProtocolError) as orphan:
        request_violation({**request(), "input": [user("hi"), output]}, MODEL)
    assert orphan.value.code == "invalid_request"
    with pytest.raises(ProtocolError) as undeclared:
        request_violation(
            {**request(), "input": [user("hi"), update]}, model_with(reasoning_effort_updates=False)
        )
    assert undeclared.value.code == "unsupported_parameter"


def test_capability_checks():
    with pytest.raises(ProtocolError) as parallel:
        request_violation(
            {**request(), "parallel_tool_calls": True}, model_with(parallel_tool_calls=False)
        )
    assert parallel.value.param == "parallel_tool_calls"
    with pytest.raises(ProtocolError) as limit:
        request_violation({**request(), "max_output_tokens": MODEL["max_output_tokens"] + 1}, MODEL)
    assert limit.value.code == "invalid_request"


def test_strict_tools_need_structured_output():
    def tool(**extra):
        return {"type": "function", "name": "f", "parameters": {"type": "object"}, **extra}

    incapable = model_with(structured_output=False)
    with pytest.raises(ProtocolError) as strict:
        request_violation({**request(), "tools": [tool(strict=True)]}, incapable)
    assert (strict.value.code, strict.value.param) == ("unsupported_parameter", "tools[0].strict")
    request_violation({**request(), "tools": [tool(strict=False), tool(name="g")]}, incapable)
    capable = model_with(structured_output=True)
    request_violation({**request(), "tools": [tool(strict=True)]}, capable)


def test_effective_effort_order():
    update = lambda effort: {"type": "configuration_update", "reasoning": {"effort": effort}}  # noqa: E731
    params = {
        **request(),
        "reasoning": {"effort": "none"},
        "input": [user("a"), update("low"), user("b"), update("high")],
    }
    assert effective_effort(params, MODEL) == "high"
    assert effective_effort({**request(), "reasoning": {"effort": "none"}}, MODEL) == "none"
    assert effective_effort(request(), MODEL) == MODEL["reasoning"]["default_effort"]


def test_continuation_properties_and_expansion():
    first = request("one")
    assert same_properties(
        first, {**first, "input": [], "client_metadata": {"a": "b"}, "generate": False}
    )
    assert not same_properties(first, {**first, "max_output_tokens": 10})
    output = [
        {
            "type": "message",
            "id": "msg_1",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "x"}],
        }
    ]
    full = expand_continuation(first, output, {**first, "input": [user("two")]})
    assert full["input"] == [user("one"), *output, user("two")]


def png(width: int = 40, height: int = 24) -> bytes:
    import io

    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (10, 200, 30)).save(buffer, format="PNG")
    return buffer.getvalue()


def data_url(kind: str, data: bytes) -> str:
    import base64

    return f"data:image/{kind};base64," + base64.b64encode(data).decode()


def test_image_structure_matches_the_frontend_rule():
    """protocol 7.1, the same cases as protocol.test.ts."""
    from aporisa_backend.protocol.images import ImageInfo, image_info

    # SOI, APP0 (empty), SOF0 (height 24, width 40), EOI
    jpeg = bytes.fromhex("ffd8ffe00002ffc0000b080018002801011100ffd9")
    assert image_info(data_url("png", png())) == ImageInfo("png", 40, 24)
    assert image_info(data_url("jpeg", jpeg)) == ImageInfo("jpeg", 40, 24)
    assert image_info(data_url("png", b"plain text, no image")) is None
    assert image_info(data_url("jpeg", png())) is None
    assert image_info(data_url("png", jpeg)) is None
    assert image_info(data_url("png", png()[:-12])) is None
    assert image_info(data_url("jpeg", jpeg[:-2])) is None


def test_images_are_checked_after_the_modality():
    image = {"type": "input_image", "image_url": data_url("png", b"nope")}
    body = {
        **request(),
        "input": [{"type": "message", "role": "user", "content": [image]}],
    }
    with pytest.raises(ProtocolError) as broken:
        request_violation(body, MODEL)
    assert (broken.value.code, broken.value.param) == ("invalid_image", "input[0].content[0]")
    text_only = {**MODEL, "input_modalities": ["text"]}
    with pytest.raises(ProtocolError) as unsupported:
        request_violation(body, text_only)
    assert unsupported.value.code == "unsupported_parameter"
