"""Shared fixtures: the real gateway on a random loopback port, backed by the fake worker."""

from __future__ import annotations

import asyncio
import json
import sys
import threading
import time
from dataclasses import replace
from pathlib import Path

import httpx
import pytest
import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parent))

from aporisa_backend.configs.limits import LIMITS  # noqa: E402
from aporisa_backend.configs.models import PROFILES, active_pointer  # noqa: E402
from aporisa_backend.fake.worker import FakeWorker, echo_script  # noqa: E402
from aporisa_backend.gateway.app import create_app  # noqa: E402
from aporisa_backend.gateway.runtime import Runtime  # noqa: E402

API_KEY = "test-key"
ALIAS, IDENTITY = active_pointer()
PROFILE = PROFILES[IDENTITY]


class Server:
    """uvicorn in a background thread with its own event loop."""

    def __init__(self, app):
        self.config = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=0,
            ws="websockets-sansio",
            lifespan="on",
            log_level="critical",
            access_log=False,
        )
        self.server = uvicorn.Server(self.config)
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def __enter__(self) -> Server:
        self.thread.start()
        deadline = time.monotonic() + 10
        while not self.server.started:
            if time.monotonic() > deadline or not self.thread.is_alive():
                raise RuntimeError("test server did not start")
            time.sleep(0.01)
        port = self.server.servers[0].sockets[0].getsockname()[1]
        self.base = f"http://127.0.0.1:{port}"
        self.ws_url = f"ws://127.0.0.1:{port}/v1/responses"
        return self

    def __exit__(self, *exc) -> None:
        self.server.should_exit = True
        self.thread.join(timeout=10)


class Harness:
    def __init__(self, limits=LIMITS, **worker_options):
        self.workers: list[FakeWorker] = []
        options = {"chunk_size": 4, **worker_options}

        def factory() -> FakeWorker:
            worker = FakeWorker(PROFILE, ALIAS, **options)
            self.workers.append(worker)
            return worker

        self.runtime = Runtime(ALIAS, PROFILE, factory, limits)
        self.app = create_app(self.runtime, API_KEY, limits)

    @property
    def worker(self) -> FakeWorker:
        return self.workers[-1]


@pytest.fixture
def harness_factory():
    servers = []

    def make(limits=LIMITS, **worker_options):
        harness = Harness(limits, **worker_options)
        server = Server(harness.app).__enter__()
        servers.append(server)
        harness.server = server
        return harness

    yield make
    for server in servers:
        server.__exit__()


@pytest.fixture
def harness(harness_factory):
    return harness_factory()


def limits(**overrides):
    return replace(LIMITS, **overrides)


def auth() -> dict:
    return {"authorization": f"Bearer {API_KEY}"}


def user(text: str) -> dict:
    return {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}


def request(text: str = "hello", **extra) -> dict:
    return {"model": ALIAS, "input": [user(text)], "max_output_tokens": 256, **extra}


async def post_stream(
    base: str, body: dict, headers: dict | None = None
) -> tuple[int, list[dict] | dict]:
    """POSTs /v1/responses; returns (status, events) for streams or (status, error body)."""
    async with httpx.AsyncClient(timeout=30) as client:
        async with client.stream(
            "POST",
            f"{base}/v1/responses",
            json={**body, "stream": True},
            headers={**auth(), **(headers or {})},
        ) as response:
            if response.headers.get("content-type", "").startswith("text/event-stream"):
                events, data = [], []
                async for line in response.aiter_lines():
                    if line.startswith("data: "):
                        data.append(line[6:])
                    elif line == "" and data:
                        events.append(json.loads("\n".join(data)))
                        data = []
                return response.status_code, events
            return response.status_code, json.loads(await response.aread())


async def eventually(predicate, within_s: float = 5.0) -> bool:
    """Polls state owned by the server thread's event loop (an asyncio.Event cannot cross it)."""
    deadline = time.monotonic() + within_s
    while not predicate() and time.monotonic() < deadline:  # noqa: ASYNC110
        await asyncio.sleep(0.02)
    return predicate()


@pytest.fixture(scope="session")
def tiny_model_dir(tmp_path_factory):
    """A tiny random qwen4_exp checkpoint in the served layout (tests/tiny_model.py)."""
    from assets import MODEL_DIR

    if not (MODEL_DIR / "tokenizer.json").is_file():
        pytest.skip(f"local model files not found under {MODEL_DIR}")
    import tiny_model

    return tiny_model.build(MODEL_DIR, tmp_path_factory.mktemp("tiny"))


def worker_init(model_dir, **overrides) -> dict:
    """The init frame the gateway sends a worker, for in-process engine tests."""
    from aporisa_backend.configs.engine import ENGINE
    from aporisa_backend.configs.models import public_model

    return {
        "op": "init",
        "model_dir": str(model_dir),
        "model": public_model(ALIAS, PROFILE),
        "adapter": PROFILE.adapter,
        "kv_bytes_per_token": PROFILE.kv_bytes_per_token,
        "snapshot_budget_bytes": 2 * 1024**3,
        "engine": ENGINE.as_dict(),
        **overrides,
    }


__all__ = ["echo_script"]
