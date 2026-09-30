"""Gateway + real worker subprocess + tiny model, over HTTP: IPC, cancel, recovery.

The tiny model's output is random, so these check protocol invariants and lifecycle, not
content; the wire conformance suite runs against the real model (docs/validation.md).
"""

from __future__ import annotations

import asyncio
import os
import signal

import httpx
import pytest
from conftest import ALIAS, API_KEY, PROFILE, Server, auth, eventually, limits, post_stream, request
from streamcheck import check_stream

from aporisa_backend.configs.models import public_model
from aporisa_backend.gateway.app import create_app
from aporisa_backend.gateway.process_worker import ProcessWorker
from aporisa_backend.gateway.runtime import Runtime


@pytest.fixture
def served(tiny_model_dir):
    workers: list[ProcessWorker] = []
    service_limits = limits(restart_backoff_s=0.1, worker_start_timeout_s=120)

    def factory() -> ProcessWorker:
        worker = ProcessWorker(
            tiny_model_dir,
            public_model(ALIAS, PROFILE),
            PROFILE,
            snapshot_budget_bytes=2 * 1024**3,
        )
        workers.append(worker)
        return worker

    runtime = Runtime(ALIAS, PROFILE, factory, service_limits)
    with Server(create_app(runtime, API_KEY, service_limits)) as server:
        server.runtime, server.workers = runtime, workers
        yield server


async def test_streams_counts_and_prompt_cache(served):
    base = served.base
    body = request("Hello worker.", max_output_tokens=12, prompt_cache_key="thread-1")
    status, events = await post_stream(base, body)
    assert status == 200
    first = check_stream(events)
    assert first["status"] in ("completed", "incomplete", "failed")
    async with httpx.AsyncClient(timeout=30) as client:
        counted = await client.post(f"{base}/v1/responses/input_tokens", json=body, headers=auth())
    assert counted.status_code == 200
    if first["usage"]:
        assert counted.json()["input_tokens"] == first["usage"]["input_tokens"]
    status, events = await post_stream(base, {**body, "generate": False})
    warm = check_stream(events, prewarm=True)
    # Same session, same prompt: the prompt is a prefix of what the cache already holds
    # (unless the first generation failed after a broken random tool call).
    if first["status"] != "failed":
        assert warm["usage"]["input_tokens_details"]["cached_tokens"] > 0


async def test_client_disconnect_cancels_and_frees_admission(served):
    base = served.base
    async with httpx.AsyncClient(timeout=30) as client:
        async with client.stream(
            "POST",
            f"{base}/v1/responses",
            json={**request("long", max_output_tokens=4000, tool_choice="none"), "stream": True},
            headers=auth(),
        ) as response:
            async for line in response.aiter_lines():
                if "output_text.delta" in line or "reasoning_text.delta" in line:
                    break
    assert await eventually(lambda: served.runtime.admission.active == 0, 10)
    assert served.workers[-1].alive
    status, events = await post_stream(base, request("after", max_output_tokens=4))
    assert status == 200 and check_stream(events)


async def test_worker_crash_fails_stream_and_restarts(served):
    base = served.base
    stream = asyncio.create_task(
        post_stream(base, request("crash", max_output_tokens=4000, tool_choice="none"))
    )
    await asyncio.sleep(1.0)
    os.killpg(served.workers[-1].proc.pid, signal.SIGKILL)
    _, events = await stream
    response = check_stream(events)
    assert response["status"] == "failed" and response["error"]["code"] == "engine_failure"
    assert await eventually(
        lambda: served.runtime.state == "ready" and len(served.workers) == 2, 60
    )
    status, events = await post_stream(base, request("again", max_output_tokens=4))
    assert status == 200 and check_stream(events)
