"""Gateway over HTTP with the fake worker: routing, bounds, streams, admission, recovery."""

from __future__ import annotations

import asyncio

import httpx
from conftest import ALIAS, auth, eventually, limits, post_stream, request
from streamcheck import check_stream


async def get(base: str, path: str, headers: dict | None = None) -> httpx.Response:
    async with httpx.AsyncClient(timeout=10) as client:
        return await client.get(f"{base}{path}", headers=headers or {})


async def test_routing_and_authentication(harness):
    base = harness.server.base
    assert (await get(base, "/health/live")).json() == {"status": "alive"}
    assert (await get(base, "/health/ready")).json() == {"status": "ready"}
    assert (await get(base, "/elsewhere")).json()["error"]["code"] == "not_found"
    unauthorized = await get(base, "/v1/models")
    assert unauthorized.status_code == 401 and unauthorized.headers["www-authenticate"] == "Bearer"
    assert (await get(base, "/v1/nope", auth())).status_code == 404
    models = (await get(base, "/v1/models", auth())).json()
    assert models["object"] == "list" and models["data"][0]["id"] == ALIAS
    assert (await get(base, "/v1/models/other", auth())).json()["error"][
        "code"
    ] == "model_not_found"
    assert (await get(base, "/health/runtime")).status_code == 401
    assert (await get(base, "/health/runtime", auth())).json()["state"] == "ready"
    assert (await get(base, "/docs", auth())).status_code == 404


async def test_body_bounds_and_media_type(harness_factory):
    harness = harness_factory(limits(max_body_bytes=512))
    base = harness.server.base
    async with httpx.AsyncClient(timeout=10) as client:
        plain = await client.post(
            f"{base}/v1/responses", content=b"{}", headers={**auth(), "content-type": "text/plain"}
        )
        assert plain.status_code == 415
        big = await client.post(f"{base}/v1/responses", json={"x": "a" * 1000}, headers=auth())
        assert big.status_code == 413 and big.json()["error"]["code"] == "request_too_large"
        dup = await client.post(
            f"{base}/v1/responses",
            content=b'{"a":1,"a":2}',
            headers={**auth(), "content-type": "application/json"},
        )
        assert dup.json()["error"]["code"] == "invalid_request"


async def test_stream_follows_the_protocol(harness):
    status, events = await post_stream(harness.server.base, request("hi"))
    assert status == 200
    response = check_stream(events)
    assert response["status"] == "completed"
    assert response["output"][0]["content"][0]["text"] == "echo: hi"
    assert response["output"][0]["phase"] == "final_answer"
    assert response["usage"]["input_tokens"] > 0


async def test_prewarm_then_prompt_cache(harness):
    base = harness.server.base
    status, events = await post_stream(base, request("hi", generate=False, prompt_cache_key="t1"))
    check_stream(events, prewarm=True)
    _, events = await post_stream(base, request("hi", prompt_cache_key="t1"))
    assert check_stream(events)["usage"]["input_tokens_details"]["cached_tokens"] > 0


async def test_context_length_rejected_before_streaming(harness):
    status, body = await post_stream(harness.server.base, request("a " * 600_000))
    assert status == 400 and body["error"]["code"] == "context_length_exceeded"
    assert body["error"]["param"] == "input"


async def test_input_tokens_matches_usage(harness):
    base = harness.server.base
    async with httpx.AsyncClient(timeout=10) as client:
        counted = (
            await client.post(
                f"{base}/v1/responses/input_tokens", json=request("hi"), headers=auth()
            )
        ).json()
    _, events = await post_stream(base, request("hi"))
    assert counted["input_tokens"] == check_stream(events)["usage"]["input_tokens"]


async def test_queue_full_and_timeout(harness_factory):
    harness = harness_factory(limits(queued_requests=1, queue_timeout_s=0.3), chunk_delay_s=0.2)
    base = harness.server.base
    slow = request("x" * 40)
    first = asyncio.create_task(post_stream(base, slow))
    await asyncio.sleep(0.2)
    second = asyncio.create_task(post_stream(base, slow))
    await asyncio.sleep(0.05)
    status, body = await post_stream(base, slow)
    assert status == 429 and body["error"]["code"] == "queue_full"
    status, body = await second
    assert status == 429 and body["error"]["code"] == "queue_timeout"
    assert (await first)[0] == 200


async def test_disconnect_cancels_and_frees_admission(harness_factory):
    harness = harness_factory(chunk_delay_s=0.1)
    base = harness.server.base
    async with httpx.AsyncClient(timeout=10) as client:
        async with client.stream(
            "POST",
            f"{base}/v1/responses",
            json={**request("x" * 200), "stream": True},
            headers=auth(),
        ) as response:
            async for _ in response.aiter_lines():
                break
    assert await eventually(lambda: not harness.worker.active), "the worker job was not cancelled"
    status, events = await post_stream(base, request("next"))
    assert status == 200 and check_stream(events)["status"] == "completed"


async def test_idle_timeout_and_output_limit(harness_factory):
    idle = harness_factory(limits(idle_timeout_s=0.2), chunk_delay_s=0.5)
    _, events = await post_stream(idle.server.base, request("x" * 20))
    response = check_stream(events)
    assert response["status"] == "failed" and response["error"]["code"] == "inference_timeout"
    capped = harness_factory(limits(max_output_bytes=8))
    _, events = await post_stream(capped.server.base, request("x" * 40))
    response = check_stream(events)
    assert response["status"] == "failed" and response["error"]["code"] == "output_limit_exceeded"


async def test_worker_crash_fails_the_stream_and_recovers(harness_factory):
    harness = harness_factory(limits(restart_backoff_s=0.05), chunk_delay_s=0.2)
    base = harness.server.base
    stream = asyncio.create_task(post_stream(base, request("x" * 80)))
    await asyncio.sleep(0.3)
    harness.worker.kill()
    _, events = await stream
    response = check_stream(events)
    assert response["status"] == "failed" and response["error"]["code"] == "engine_failure"
    assert await eventually(lambda: harness.runtime.state == "ready" and len(harness.workers) == 2)
    assert (await get(base, "/health/ready")).status_code == 200
    _, events = await post_stream(base, request("after"))
    assert check_stream(events)["status"] == "completed"


async def test_recovery_budget_exhausted(harness_factory):
    harness = harness_factory(limits(restart_attempts=0))
    base = harness.server.base
    harness.worker.kill()
    assert await eventually(lambda: harness.runtime.state == "failed")
    ready = await get(base, "/health/ready")
    assert ready.status_code == 503
    status, body = await post_stream(base, request("x"))
    assert status == 503 and body["error"]["code"] == "service_not_ready"


async def test_tool_call_invalid_keeps_completed_items(harness_factory):
    def script(_params, _index):
        return [
            {"type": "message", "text": "Checking.", "phase": "commentary"},
            {"type": "malformed_tool_call", "name": "exec_command", "detail": "unclosed"},
        ]

    harness = harness_factory(script=script)
    _, events = await post_stream(harness.server.base, request("go"))
    response = check_stream(events)
    assert response["status"] == "failed"
    assert response["error"] == {
        "code": "tool_call_invalid",
        "message": "Tool call markup is not closed.",
    }
    assert [item["type"] for item in response["output"]] == ["message"]
