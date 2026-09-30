#!/usr/bin/env python3
"""Bounded real-generation checks against the running backend (DEVELOPMENT_PLAN 14.8, P4).

    backend/.venv/bin/python scripts/validate_runtime.py [--long TOKENS]

Run explicitly by the user against a started service (./backend_service.sh start); never
part of scripts/check.sh. Uses the Aporisa protocol directly (HTTP/SSE and WebSocket),
with the key and port from backend/.env. Default checks take a few minutes:

  text          effort none: a completed message, no reasoning
  thinking      effort low: reasoning then an answer (or a clean max_output_tokens stop)
  tool call     a valid function_call, then an answer after the tool output
  prompt cache  the same prompt_cache_key reuses the prefix (cached_tokens, faster TTFT)
  websocket     previous_response_id continuation prefills only the new input
  effort switch a trailing configuration_update to none produces no reasoning
  runtime       /health/runtime includes the worker's view

--long TOKENS adds the B1-10 acceptance: one cold prefill of about TOKENS tokens (server
prefill speed against B0-5's compute-only speed) and a continuation on top of it, with
swap usage required not to grow. System memory (compressor, swap, free) is sampled every
second and each check records the memory pressure it caused. Results (numbers only, never
text) are appended to .runtime/validation/validate_<time>.jsonl.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend" / "src"))

import httpx  # noqa: E402
import psutil  # noqa: E402
import websockets  # noqa: E402

from aporisa_backend import vmstats  # noqa: E402
from aporisa_backend.configs.models import active_pointer  # noqa: E402
from aporisa_backend.configs.settings import Settings  # noqa: E402
from aporisa_backend.console import emit  # noqa: E402

TIMEOUT_S = 600
LONG_TIMEOUT_S = 3600
TERMINAL = {"response.completed", "response.incomplete", "response.failed"}
# B0-5 (docs/validation.md): affine4g64 compute-only prefill tok/s by context length.
B0_PREFILL = [(2048, 954), (32768, 771), (131072, 682), (262144, 574)]
PREFILL_RATIO_REQUIRED = 0.8
SWAP_GROWTH_ALLOWED = 256 * 1024**2

TOOLS = [
    {
        "type": "function",
        "name": "read_file",
        "description": "Read a text file from the repository and return its contents.",
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "Repository path"}},
            "required": ["path"],
        },
    }
]


def user(text: str) -> dict:
    return {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}


def as_input(items: list[dict]) -> list[dict]:
    """Output items as a harness sends them back."""
    return [dict(item) for item in items]


class Failure(Exception):
    pass


def check(condition: bool, what: str) -> None:
    if not condition:
        raise Failure(what)


class Validator:
    def __init__(self, settings: Settings, alias: str, results: Path):
        self.alias = alias
        self.base = f"http://{settings.host}:{settings.port}"
        self.ws_url = f"ws://{settings.host}:{settings.port}/v1/responses"
        self.headers = {"authorization": f"Bearer {settings.api_key}"}
        self.results = results
        self.failed = 0
        self.phase = "start"
        self.started = time.monotonic()
        self.peak_compressor = 0

    def record(self, check_name: str, **numbers) -> None:
        self.results.parent.mkdir(parents=True, exist_ok=True)
        with self.results.open("a") as stream:
            stream.write(json.dumps({"check": check_name, **numbers}) + "\n")

    def request(self, input_items: list[dict], **extra) -> dict:
        return {"model": self.alias, "input": input_items, "max_output_tokens": 256, **extra}

    async def stream(self, client: httpx.AsyncClient, body: dict) -> tuple[dict, float | None]:
        """POST /v1/responses; returns (terminal response, client-side TTFT seconds)."""
        started, first = time.monotonic(), None
        async with client.stream(
            "POST", f"{self.base}/v1/responses", json={**body, "stream": True}, headers=self.headers
        ) as response:
            check(response.status_code == 200, f"HTTP {response.status_code}")
            data: list[str] = []
            async for line in response.aiter_lines():
                if line.startswith("data: "):
                    data.append(line[6:])
                    continue
                if line or not data:
                    continue
                event = json.loads("\n".join(data))
                data = []
                if first is None and event["type"].endswith(".delta"):
                    first = time.monotonic() - started
                if event["type"] in TERMINAL:
                    return event["response"], first
        raise Failure("stream ended without a terminal event")

    async def runtime(self, client: httpx.AsyncClient) -> dict:
        response = await client.get(f"{self.base}/health/runtime", headers=self.headers)
        check(response.status_code == 200, "runtime status unavailable")
        return response.json()

    async def run(self, name: str, coroutine, timeout_s: float = TIMEOUT_S) -> None:
        self.phase = name
        before = vmstats.sample()
        try:
            async with asyncio.timeout(timeout_s):
                await coroutine
        except Exception as error:  # noqa: BLE001 - every failure is reported, none crashes
            self.failed += 1
            reason = str(error) if isinstance(error, Failure) else type(error).__name__
            self.record(name, passed=False)
            emit("ERROR", f"{name}: {reason}")
        pressure = vmstats.delta(before, vmstats.sample())
        self.record(f"{name}.pressure", **pressure)
        if pressure["sys_swapouts"] or pressure["swap_growth_bytes"] > 0:
            emit(
                "WAIT",
                f"{name}: system swapped out {pressure['sys_swapouts']} pages "
                f"(swap {pressure['swap_growth_bytes'] / 1024**2:+.0f} MiB) during this check.",
            )

    async def sample_memory(self) -> None:
        """Once a second: system compressor, swap and free memory, tagged with the check."""
        while True:
            now = vmstats.sample()
            self.peak_compressor = max(self.peak_compressor, now["compressor_bytes"])
            self.record(
                "vm",
                phase=self.phase,
                t_s=round(time.monotonic() - self.started, 1),
                compressor_bytes=now["compressor_bytes"],
                swap_used_bytes=now["swap_used_bytes"],
                free_bytes=now["free_bytes"],
                swapouts=now["swapouts"],
                compressions=now["compressions"],
            )
            await asyncio.sleep(1)

    # --- checks -----------------------------------------------------------------------------

    async def ready(self, client):
        check((await client.get(f"{self.base}/health/ready")).status_code == 200, "not ready")
        models = (await client.get(f"{self.base}/v1/models", headers=self.headers)).json()
        check([m["id"] for m in models["data"]] == [self.alias], "unexpected model list")
        emit("READY", f"Service ready; model {self.alias}.")

    async def text(self, client):
        body = self.request(
            [user("Reply with exactly one word: ready")],
            reasoning={"effort": "none"},
            max_output_tokens=16,
        )
        response, ttft = await self.stream(client, body)
        check(response["status"] == "completed", f"status {response['status']}")
        kinds = [item["type"] for item in response["output"]]
        check("message" in kinds and "reasoning" not in kinds, f"output {kinds}")
        usage = response["usage"]
        check(usage["output_tokens_details"]["reasoning_tokens"] == 0, "reasoning tokens in none")
        self.record("text", passed=True, ttft_ms=round((ttft or 0) * 1000), **_usage(usage))
        emit("READY", "Text generation (effort none) passed.")

    async def thinking(self, client):
        body = self.request(
            [user("What is 17 * 23? Answer with the number only.")],
            reasoning={"effort": "low"},
            max_output_tokens=2048,
        )
        response, _ = await self.stream(client, body)
        status = response["status"]
        check(status in ("completed", "incomplete"), f"status {status}")
        kinds = [item["type"] for item in response["output"]]
        if status == "completed":
            check("message" in kinds, f"no answer: {kinds}")
        check(response["usage"]["output_tokens_details"]["reasoning_tokens"] > 0, "no reasoning")
        self.record("thinking", passed=True, status=status, **_usage(response["usage"]))
        emit("READY", f"Thinking protocol passed ({status}).")

    async def tool_call(self, client):
        history = [
            user(
                "Use the read_file tool to read README.md, then tell me its first heading. "
                "Call the tool first; do not guess."
            )
        ]
        body = self.request(
            history, tools=TOOLS, reasoning={"effort": "low"}, max_output_tokens=2048
        )
        response, _ = await self.stream(client, body)
        check(response["status"] == "completed", f"status {response['status']}")
        calls = [item for item in response["output"] if item["type"] == "function_call"]
        check(calls and calls[0]["name"] == "read_file", "no read_file call")
        arguments = json.loads(calls[0]["arguments"])
        check(isinstance(arguments, dict) and "path" in arguments, "arguments lack path")
        output = {
            "type": "function_call_output",
            "call_id": calls[0]["call_id"],
            "output": "# Aporisa Code\n\nA local agent app.",
        }
        follow = self.request(
            [*history, *as_input(response["output"]), output],
            tools=TOOLS,
            reasoning={"effort": "low"},
            max_output_tokens=2048,
        )
        answer, _ = await self.stream(client, follow)
        check(answer["status"] == "completed", f"follow-up status {answer['status']}")
        check(any(i["type"] == "message" for i in answer["output"]), "no answer after the tool")
        self.record("tool_call", passed=True, **_usage(answer["usage"]))
        emit("READY", "Tool call and tool-output follow-up passed.")

    async def prompt_cache(self, client):
        key = f"validate-{time.time_ns()}"
        context = _corpus(12_000)
        first_body = self.request(
            [user(f"Here is some context:\n\n{context}\n\nSummarize it in one sentence.")],
            reasoning={"effort": "none"},
            max_output_tokens=256,
            prompt_cache_key=key,
        )
        first, ttft_cold = await self.stream(client, first_body)
        # A completed turn is needed: an incomplete one drops its unfinished message, so the
        # follow-up history would diverge right after the user turn.
        check(first["status"] == "completed", f"status {first['status']}")
        second_body = {
            **first_body,
            "input": [*first_body["input"], *as_input(first["output"]), user("Now in five words.")],
        }
        second, ttft_warm = await self.stream(client, second_body)
        cached = second["usage"]["input_tokens_details"]["cached_tokens"]
        check(cached >= first["usage"]["input_tokens"], f"cached_tokens {cached}")
        self.record(
            "prompt_cache",
            passed=True,
            input_tokens=second["usage"]["input_tokens"],
            cached_tokens=cached,
            ttft_cold_ms=round((ttft_cold or 0) * 1000),
            ttft_warm_ms=round((ttft_warm or 0) * 1000),
        )
        emit(
            "READY",
            f"Prompt cache passed: reused {cached} of {second['usage']['input_tokens']} tokens; "
            f"TTFT {ttft_cold or 0:.2f}s cold -> {ttft_warm or 0:.2f}s warm.",
        )

    async def websocket(self, client):
        async with websockets.connect(self.ws_url, additional_headers=self.headers) as ws:

            async def create(body: dict) -> dict:
                await ws.send(json.dumps({"type": "response.create", **body}))
                while True:
                    event = json.loads(await ws.recv())
                    check(event["type"] != "error", f"websocket error {event.get('error')}")
                    if event["type"] in TERMINAL:
                        return event["response"]

            base = self.request(
                [user("Name one primary color.")],
                reasoning={"effort": "none"},
                max_output_tokens=32,
            )
            first = await create(base)
            check(first["status"] == "completed", f"status {first['status']}")
            second = await create(
                {**base, "input": [user("And another one.")], "previous_response_id": first["id"]}
            )
            cached = second["usage"]["input_tokens_details"]["cached_tokens"]
            check(cached >= first["usage"]["input_tokens"], f"cached_tokens {cached}")
            status = await self.runtime(client)
            restore = (status.get("worker") or {}).get("last", {}).get("restore_path")
            check(restore == "live", f"restore path {restore}")
        self.record("websocket", passed=True, cached_tokens=cached)
        emit("READY", f"WebSocket continuation passed (live path, {cached} tokens reused).")

    async def effort_switch(self, client):
        items = [
            user("Remember the number 42."),
            {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "Noted."}],
            },
            {"type": "configuration_update", "reasoning": {"effort": "none"}},
            user("Which number did I ask you to remember? Answer with the number only."),
        ]
        body = self.request(items, reasoning={"effort": "medium"}, max_output_tokens=32)
        response, _ = await self.stream(client, body)
        check(response["status"] == "completed", f"status {response['status']}")
        check(all(i["type"] != "reasoning" for i in response["output"]), "reasoning after none")
        check(response["usage"]["output_tokens_details"]["reasoning_tokens"] == 0, "tokens")
        self.record("effort_switch", passed=True, **_usage(response["usage"]))
        emit("READY", "Mid-conversation switch to effort none passed.")

    async def runtime_status(self, client):
        status = await self.runtime(client)
        worker = status.get("worker")
        check(status["state"] == "ready" and worker is not None, "worker status missing")
        self.record(
            "runtime",
            passed=True,
            sessions=worker["sessions"],
            session_bytes=worker["session_bytes"],
            weights_bytes=worker["weights_bytes"],
            active_memory_bytes=worker["active_memory_bytes"],
        )
        emit(
            "READY",
            f"Runtime status passed: {worker['sessions']} sessions, "
            f"{worker['session_bytes'] / 1024**3:.2f} GiB of session state.",
        )

    async def long_context(self, client, tokens: int):
        emit("WAIT", f"Long-context check: building a prompt of about {tokens} tokens...")
        key = f"validate-long-{time.time_ns()}"
        question = "\n\nIn one sentence, what is this text about?"
        chars = tokens * 3
        for _ in range(3):
            body = self.request(
                [user(_corpus(chars) + question)],
                reasoning={"effort": "none"},
                max_output_tokens=256,
                prompt_cache_key=key,
            )
            counted = await client.post(
                f"{self.base}/v1/responses/input_tokens", json=body, headers=self.headers
            )
            check(counted.status_code == 200, "token counting failed")
            count = counted.json()["input_tokens"]
            if abs(count - tokens) <= tokens * 0.02:
                break
            chars = int(chars * tokens / count)
        swap_before = psutil.swap_memory().used
        emit("WAIT", f"Cold prefill of {count} tokens (this takes several minutes)...")
        first, ttft = await self.stream(client, body)
        check(first["status"] == "completed", f"status {first['status']}")
        last = (await self.runtime(client))["worker"]["last"]
        speed = last.get("prefill_tok_s") or 0
        reference = _reference(count)
        ratio = speed / reference
        follow = {
            **body,
            "input": [*body["input"], *as_input(first["output"]), user("Now in three words.")],
        }
        second, ttft_warm = await self.stream(client, follow)
        cached = second["usage"]["input_tokens_details"]["cached_tokens"]
        swap_growth = psutil.swap_memory().used - swap_before
        self.record(
            "long_context",
            passed=ratio >= PREFILL_RATIO_REQUIRED
            and cached >= first["usage"]["input_tokens"]
            and swap_growth < SWAP_GROWTH_ALLOWED,
            input_tokens=first["usage"]["input_tokens"],
            prefill_tok_s=speed,
            b0_compute_tok_s=round(reference),
            ratio=round(ratio, 3),
            ttft_cold_ms=round((ttft or 0) * 1000),
            ttft_continue_ms=round((ttft_warm or 0) * 1000),
            cached_tokens=cached,
            ple_lookup_ms=last.get("ple_lookup_ms"),
            ple_prefetch_ms=last.get("ple_prefetch_ms"),
            peak_memory_bytes=last.get("peak_memory_bytes"),
            swap_growth_bytes=swap_growth,
        )
        check(
            ratio >= PREFILL_RATIO_REQUIRED,
            f"prefill {speed:.0f} tok/s is {ratio:.0%} of B0-5's {reference:.0f}",
        )
        check(cached >= first["usage"]["input_tokens"], f"continuation cached {cached}")
        check(swap_growth < SWAP_GROWTH_ALLOWED, f"swap grew by {swap_growth / 1024**2:.0f} MiB")
        emit(
            "READY",
            f"Long context passed: {count} tokens at {speed:.0f} tok/s ({ratio:.0%} of B0-5 "
            f"compute-only {reference:.0f}); continuation TTFT {ttft_warm or 0:.2f}s; "
            f"swap growth {swap_growth / 1024**2:.0f} MiB.",
        )


def _usage(usage: dict) -> dict:
    return {
        "input_tokens": usage["input_tokens"],
        "cached_tokens": usage["input_tokens_details"]["cached_tokens"],
        "output_tokens": usage["output_tokens"],
        "reasoning_tokens": usage["output_tokens_details"]["reasoning_tokens"],
    }


def _reference(tokens: int) -> float:
    """B0-5 compute-only prefill speed, interpolated in log(context length)."""
    points = B0_PREFILL
    if tokens <= points[0][0]:
        return points[0][1]
    for (x0, y0), (x1, y1) in zip(points, points[1:], strict=False):
        if tokens <= x1:
            t = (math.log(tokens) - math.log(x0)) / (math.log(x1) - math.log(x0))
            return y0 + t * (y1 - y0)
    return points[-1][1]


def _corpus(chars: int) -> str:
    """Repository docs and sources (tracked files only), repeated to `chars` characters."""
    sources = sorted(
        [
            *ROOT.glob("docs/*.md"),
            *ROOT.glob("aporisa_code/src/**/*.ts"),
            *ROOT.glob("backend/src/**/*.py"),
        ]
    )
    text = "\n\n".join(p.read_text() for p in sources if p.is_file())
    return (text * (chars // max(len(text), 1) + 1))[:chars]


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--long", type=int, metavar="TOKENS", help="add the long-context check")
    args = parser.parse_args()
    if args.long is not None and not 4096 <= args.long <= 250_000:
        emit("ERROR", "--long must be between 4096 and 250000 tokens.")
        return 2
    settings = Settings.read()
    alias, _ = active_pointer()
    stamp = time.strftime("%Y%m%d_%H%M%S")
    validator = Validator(
        settings, alias, ROOT / ".runtime" / "validation" / f"validate_{stamp}.jsonl"
    )
    first = vmstats.sample()
    sampler = asyncio.create_task(validator.sample_memory())
    async with httpx.AsyncClient(timeout=TIMEOUT_S, trust_env=False) as client:
        checks = [
            ("ready", validator.ready(client)),
            ("text", validator.text(client)),
            ("thinking", validator.thinking(client)),
            ("tool_call", validator.tool_call(client)),
            ("prompt_cache", validator.prompt_cache(client)),
            ("websocket", validator.websocket(client)),
            ("effort_switch", validator.effort_switch(client)),
            ("runtime", validator.runtime_status(client)),
        ]
        for name, coroutine in checks:
            await validator.run(name, coroutine)
        if args.long is not None:
            checks.append(("long_context", None))
            await validator.run(
                "long_context", validator.long_context(client, args.long), LONG_TIMEOUT_S
            )
    sampler.cancel()
    total = vmstats.delta(first, vmstats.sample())
    validator.record("run.pressure", peak_compressor_bytes=validator.peak_compressor, **total)
    emit(
        "INFO",
        f"Memory over the run: swapped out {total['sys_swapouts']} pages, swap "
        f"{total['swap_growth_bytes'] / 1024**2:+.0f} MiB, compressor peak "
        f"{validator.peak_compressor / 1024**3:.1f} GiB.",
    )
    emit("INFO", f"Results: {validator.results}")
    if validator.failed:
        emit("ERROR", f"{validator.failed} of {len(checks)} checks failed.")
        return 1
    emit("READY", f"All {len(checks)} runtime checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
