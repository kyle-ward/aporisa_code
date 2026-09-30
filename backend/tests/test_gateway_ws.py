"""Gateway over WebSocket with the fake worker (docs/protocol.md section 3.3)."""

from __future__ import annotations

import asyncio
import json

import pytest
from conftest import API_KEY, eventually, limits, request, user
from streamcheck import TERMINAL, check_stream
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus


def open_ws(harness):
    return connect(harness.server.ws_url, additional_headers={"authorization": f"Bearer {API_KEY}"})


async def read_response(ws) -> list[dict]:
    events = []
    while True:
        message = json.loads(await asyncio.wait_for(ws.recv(), 10))
        assert message["type"] != "error", message
        events.append(message)
        if message["type"] in TERMINAL:
            return events


async def next_error(ws) -> dict:
    message = json.loads(await asyncio.wait_for(ws.recv(), 10))
    assert message["type"] == "error", message
    return message


async def test_upgrade_requires_authentication(harness):
    with pytest.raises(InvalidStatus) as denied:
        async with connect(harness.server.ws_url):
            pass
    assert denied.value.response.status_code == 401


async def test_continuation_is_expanded_by_the_gateway(harness):
    async with open_ws(harness) as ws:
        first = request("one", prompt_cache_key="thread")
        await ws.send(json.dumps({"type": "response.create", **first}))
        previous = check_stream(await read_response(ws))
        await ws.send(
            json.dumps(
                {
                    "type": "response.create",
                    **first,
                    "input": [user("two")],
                    "previous_response_id": previous["id"],
                }
            )
        )
        check_stream(await read_response(ws))
        full = harness.worker.requests[-1]["input"]
        assert [item.get("type") for item in full] == ["message", "message", "message"]
        assert full[1]["role"] == "assistant" and full[2] == user("two")
        await ws.send(
            json.dumps(
                {"type": "response.create", **first, "input": [], "previous_response_id": "resp_x"}
            )
        )
        assert (await next_error(ws))["error"]["code"] == "previous_response_not_found"


async def test_second_create_is_rejected_while_busy(harness_factory):
    harness = harness_factory(chunk_delay_s=0.05)
    async with open_ws(harness) as ws:
        body = json.dumps({"type": "response.create", **request("x" * 60)})
        await ws.send(body)
        await ws.send(body)
        seen_busy = terminal = False
        while not (seen_busy and terminal):
            message = json.loads(await asyncio.wait_for(ws.recv(), 10))
            if message["type"] == "error":
                assert message["error"]["code"] == "response_in_progress"
                seen_busy = True
            terminal = terminal or message["type"] in TERMINAL


async def test_interrupt_ends_incomplete_and_blocks_continuation(harness_factory):
    harness = harness_factory(chunk_delay_s=0.05)
    async with open_ws(harness) as ws:
        body = request("x" * 200)
        await ws.send(json.dumps({"type": "response.create", **body}))
        created = json.loads(await ws.recv())
        await ws.send(
            json.dumps({"type": "response.interrupt", "response_id": created["response"]["id"]})
        )
        events = [created, *await read_response(ws)]
        response = check_stream(events)
        assert response["status"] == "incomplete" and response["incomplete_details"] == {
            "reason": "interrupted"
        }
        await ws.send(
            json.dumps(
                {
                    "type": "response.create",
                    **body,
                    "input": [],
                    "previous_response_id": response["id"],
                }
            )
        )
        assert (await next_error(ws))["error"]["code"] == "previous_response_not_found"


async def test_invalid_messages_keep_the_connection(harness):
    async with open_ws(harness) as ws:
        await ws.send("{not json")
        assert (await next_error(ws))["error"]["code"] == "invalid_request"
        await ws.send(json.dumps({"type": "response.create", **request(), "stream": True}))
        assert (await next_error(ws))["error"]["code"] == "unsupported_parameter"
        await ws.send(json.dumps({"type": "response.create", **request()}))
        assert check_stream(await read_response(ws))["status"] == "completed"


async def test_lifetime_and_session_release(harness_factory):
    harness = harness_factory(limits(ws_lifetime_s=0.3))
    async with open_ws(harness) as ws:
        error = await next_error(ws)
        assert error["error"]["code"] == "connection_limit_reached" and error["status"] == 503
    assert await eventually(lambda: bool(harness.worker.released))
    assert harness.worker.released and harness.worker.released[0].startswith("conn:")
