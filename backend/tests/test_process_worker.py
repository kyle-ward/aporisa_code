"""Gateway + real worker subprocess + tiny model, over HTTP: IPC, cancel, recovery.

The tiny model's output is random, so these check protocol invariants and lifecycle, not
content; the wire conformance suite runs against the real model (docs/validation.md).
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
from dataclasses import replace

import httpx
import pytest
from conftest import ALIAS, API_KEY, PROFILE, Server, auth, eventually, limits, post_stream, request
from streamcheck import check_stream

from aporisa_backend.configs.engine import ENGINE
from aporisa_backend.configs.models import public_model
from aporisa_backend.gateway.app import create_app
from aporisa_backend.gateway.process_worker import ProcessWorker
from aporisa_backend.gateway.runtime import Runtime


@pytest.fixture
def served(tiny_model_dir, tiny_draft_dir):
    """The real worker process on the tiny model, with the tiny MTP draft model."""
    workers: list[ProcessWorker] = []
    service_limits = limits(restart_backoff_s=0.1, worker_start_timeout_s=120)

    def factory() -> ProcessWorker:
        worker = ProcessWorker(
            tiny_model_dir,
            public_model(ALIAS, PROFILE),
            PROFILE,
            draft_dir=tiny_draft_dir,
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


async def test_runtime_health_includes_worker_status(served):
    base = served.base
    status, events = await post_stream(
        base, request("status please", max_output_tokens=4, prompt_cache_key="health")
    )
    assert status == 200
    response = check_stream(events)
    async with httpx.AsyncClient(timeout=30) as client:
        health = (await client.get(f"{base}/health/runtime", headers=auth())).json()
    assert health["state"] == "ready"
    # Asked right after the terminal event: "last" is already this response (no race).
    usage = response["usage"]
    last_prefill = health["worker"]["last"]["prefill_tokens"]
    assert last_prefill == usage["input_tokens"] - usage["input_tokens_details"]["cached_tokens"]
    worker = health["worker"]
    assert worker["sessions"] >= 1 and worker["weights_bytes"] > 0
    assert worker["ple_prefetch"] is True
    # MTP loaded and warmed up with the profile's schedule
    assert worker["draft_schedule"] == [list(step) for step in PROFILE.draft_schedule]
    assert worker["released_cache_bytes"] >= 0 and "sys_swapouts" in worker["startup"]
    assert worker["locked_bytes"] > 0  # weights mlock'ed at load
    assert worker["system"]["swap_used_bytes"] >= 0 and worker["ple_files_cached_bytes"] >= 0
    assert worker["rss_bytes"] > 0 and worker["open_fds"] > 0
    last = worker["last"]
    assert last["restore_path"] in ("cold", "live", "snapshot")
    assert last["ple_bytes_read"] > 0 and last["snapshot_count"] >= 1


async def test_sessions_survive_a_restart_on_ssd(tiny_model_dir, tiny_draft_dir, tmp_path):
    """B2-1: a graceful stop writes the sessions to the SSD cache; the next worker restores
    the same prompt from there instead of prefilling it."""
    service_limits = limits(worker_start_timeout_s=120)
    root = tmp_path / "kv-cache"
    runtimes: list[Runtime] = []

    def app():
        worker = ProcessWorker(
            tiny_model_dir,
            public_model(ALIAS, PROFILE),
            PROFILE,
            draft_dir=tiny_draft_dir,
            engine=replace(ENGINE, ssd_block_tokens=64),
            snapshot_budget_bytes=2 * 1024**3,
            kv_cache={"dir": str(root), "identity": "tiny", "draft_identity": "tiny-mtp"},
        )
        runtime = Runtime(ALIAS, PROFILE, lambda: worker, service_limits)
        runtimes.append(runtime)
        return create_app(runtime, API_KEY, service_limits)

    body = request(
        "Remember this sentence for later. " * 30,
        max_output_tokens=4,
        prompt_cache_key="restart",
        reasoning={"effort": "none"},
    )
    with Server(app()) as server:
        status, events = await post_stream(server.base, body)
        assert status == 200 and check_stream(events)
    # stopped: the worker wrote its sessions and exited
    assert await eventually(lambda: runtimes[0].state == "stopped", 60)
    assert any(root.rglob("*.ckpt"))
    with Server(app()) as server:
        status, events = await post_stream(server.base, body)
        response = check_stream(events)
        async with httpx.AsyncClient(timeout=30) as client:
            health = (await client.get(f"{server.base}/health/runtime", headers=auth())).json()
    usage = response["usage"]
    assert usage["input_tokens_details"]["cached_tokens"] == usage["input_tokens"]
    last = health["worker"]["last"]
    assert last["restore_path"] == "ssd" and last["ssd_load_ms"] is not None
    assert health["worker"]["ssd_checkpoints"] >= 2 and health["worker"]["ssd_errors"] == 0


MARKER = "zq-private-marker-7f3a"
TERMINAL = ("response.completed", "response.incomplete", "response.failed")


async def test_logs_never_contain_request_content(served):
    """B1-9: prompts, tool data, metadata and outputs never reach a log line."""
    import logging

    import websockets

    from aporisa_backend.logging_config import LOGGER, ConsoleFormatter, SafeFormatter

    lines: list[str] = []

    class Capture(logging.Handler):
        def emit(self, record):
            lines.append(SafeFormatter().format(record))
            lines.append(ConsoleFormatter().format(record))

    handler, level = Capture(), LOGGER.level
    LOGGER.addHandler(handler)
    LOGGER.setLevel(logging.INFO)
    try:
        tools = [
            {
                "type": "function",
                "name": "lookup",
                "description": f"Look up {MARKER}.",
                "parameters": {"type": "object", "properties": {"q": {"type": "string"}}},
            }
        ]
        body = request(
            f"Tell me about {MARKER}.",
            max_output_tokens=6,
            instructions=f"System {MARKER}.",
            tools=tools,
            client_metadata={"note": MARKER},
            prompt_cache_key=f"key-{MARKER}",
        )
        body["input"] += [
            {
                "type": "function_call",
                "call_id": "c1",
                "name": "lookup",
                "arguments": f'{{"q": "{MARKER}"}}',
            },
            {"type": "function_call_output", "call_id": "c1", "output": f"result {MARKER}"},
        ]
        status, events = await post_stream(served.base, body)
        assert status == 200 and check_stream(events)
        status, error = await post_stream(served.base, {**body, MARKER: 1})
        assert status == 400
        async with websockets.connect(
            served.ws_url, additional_headers={"authorization": f"Bearer {API_KEY}"}
        ) as ws:
            await ws.send(json.dumps({"type": "response.create", **body}))
            while True:
                event = json.loads(await ws.recv())
                if event["type"] in TERMINAL:
                    break
    finally:
        LOGGER.removeHandler(handler)
        LOGGER.setLevel(level)
    assert lines, "no log lines were captured"
    assert not [line for line in lines if MARKER in line]
