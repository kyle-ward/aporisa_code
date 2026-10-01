#!/usr/bin/env python3
"""Bounded real-generation checks against the running backend (DEVELOPMENT_PLAN 14.8, P4).

    backend/.venv/bin/python scripts/validate_runtime.py [--long TOKENS]
    backend/.venv/bin/python scripts/validate_runtime.py --restart-prepare TOKENS
    backend/.venv/bin/python scripts/validate_runtime.py --restart-resume

Run explicitly by the user against a started service (./backend_service.sh start); never
part of scripts/check.sh. Uses the Aporisa protocol directly (HTTP/SSE and WebSocket),
with the key and port from backend/.env. Default checks take a few minutes:

  text          effort none: a completed message, no reasoning
  thinking      effort low: reasoning then an answer (or a clean max_output_tokens stop)
  tool call     a valid function_call, then an answer after the tool output
  prompt cache  the same prompt_cache_key reuses the prefix (cached_tokens, faster TTFT)
  websocket     previous_response_id continuation prefills only the new input
  effort switch a trailing configuration_update to none produces no reasoning
  speculative   MTP (B2-2): decode speed with drafts against B0-10's plain decoding, and
                the draft acceptance rate, in effort none and medium
  lookup        prompt lookup (B2-3): a code edit that copies a file, decoding at least
                twice B0-10's plain speed with lookup drafts in use
  structured    structured output (B2-4): text.format answers in effort none and medium
                are JSON of the schema; a strict tool call's arguments follow its schema
  images        image input (B2-6): the model reads a word and a colour from a generated
                picture, a picture in a tool output, and the same picture again is all
                cached while another one of the same size is not
  runtime       /health/runtime includes the worker's view

--long TOKENS adds the B1-10 acceptance: one cold prefill of about TOKENS tokens (server
prefill speed against B0-5's compute-only speed) and a continuation on top of it, with
swap usage required not to grow; then a longer answer on the same context, whose decode
speed (with MTP) must not fall below B0-5's plain decoding at that length, and a code edit
on that context whose decode speed (with prompt lookup) must be at least twice B0-5's plain
decoding. System memory
(compressor, swap, free) is sampled every second and each check records the memory pressure
it caused. Results (numbers only, never text) are appended to
.runtime/validation/validate_<time>.jsonl.

The B2-1 acceptance (SSD cache) needs a service restart in the middle, which this script
never does itself; its two halves run alone (no default checks):

  --restart-prepare TOKENS  builds a session of about TOKENS tokens and records how to
                            send the same prompt again (key, length and a hash of the
                            prompt, never its text) in .runtime/validation/restart.json
  (the user runs ./backend_service.sh restart: the graceful stop writes the session)
  --restart-resume          sends that prompt again: it must be restored from the SSD
                            cache (restore_path ssd, every token cached), first token
                            within RESTART_TTFT_REQUIRED_S
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
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
from aporisa_backend.protocol.structured import value_violation  # noqa: E402

TIMEOUT_S = 600
LONG_TIMEOUT_S = 3600
TERMINAL = {"response.completed", "response.incomplete", "response.failed"}
# B0-5 (docs/validation.md): affine4g64 compute-only prefill tok/s by context length.
B0_PREFILL = [(2048, 954), (32768, 771), (131072, 682), (262144, 574)]
# B0-5: affine4g64 plain decode tok/s by context length (DEVELOPMENT_PLAN.md section 3).
B0_DECODE = [(2048, 30.2), (32768, 26.2), (131072, 20.9), (262144, 16.2)]
LONG_DECODE_MIN_TOKENS = 64
PREFILL_RATIO_REQUIRED = 0.8
# B0-10: plain decoding at a short context, 31.0 tok/s (greedy) and 30.7 (thinking sampling);
# MTP with 2 drafts reached 1.57x and 1.47x. B2-2 requires at least 1.3x of the plain speed.
B0_PLAIN_DECODE_TOK_S = 30.7
MTP_SPEEDUP_REQUIRED = 1.3
MTP_MIN_OUTPUT_TOKENS = 128
# B2-3: copying a file with prompt-lookup drafts (P2 profile: 4.5-5.5x plain decoding).
LOOKUP_SPEEDUP_REQUIRED = 2.0
LOOKUP_MIN_OUTPUT_TOKENS = 400
EDIT_FILE = ROOT / "backend" / "src" / "aporisa_backend" / "engine" / "tokens.py"
CITY_SCHEMA = {
    "type": "object",
    "properties": {
        "city": {"type": "string"},
        "population": {"type": "integer"},
        "capital": {"type": "boolean"},
        "languages": {"type": "array", "items": {"type": "string"}},
        "size": {"type": "string", "enum": ["small", "medium", "large"]},
        "mayor": {"anyOf": [{"type": "string"}, {"type": "null"}]},
    },
    "required": ["city", "population", "capital", "languages", "size", "mayor"],
}
SWAP_GROWTH_ALLOWED = 256 * 1024**2
# B2-1: "首 token 时间在秒级" after a restart, for a 200K session restored from SSD.
RESTART_TTFT_REQUIRED_S = 10
RESTART_RECORD = ROOT / ".runtime" / "validation" / "restart.json"
LONG_QUESTION = "\n\nIn one sentence, what is this text about?"

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
                pressure_level=now["pressure_level"],
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

    async def speculative(self, client):
        required = B0_PLAIN_DECODE_TOK_S * MTP_SPEEDUP_REQUIRED
        prompt = (
            "Explain step by step how a hash map handles collisions, with a short Python "
            "example. Be thorough."
        )
        results = []
        for effort in ("none", "medium"):
            body = self.request([user(prompt)], reasoning={"effort": effort}, max_output_tokens=384)
            response, _ = await self.stream(client, body)
            status = response["status"]
            check(status in ("completed", "incomplete"), f"status {status}")
            last = (await self.runtime(client))["worker"]["last"]
            output = response["usage"]["output_tokens"]
            speed, rate = last.get("decode_tok_s") or 0, last.get("mtp_accept_rate")
            self.record(
                f"speculative.{effort}",
                output_tokens=output,
                decode_tok_s=speed,
                mtp_accept_rate=rate,
                speedup=round(speed / B0_PLAIN_DECODE_TOK_S, 3),
            )
            check(rate is not None, f"effort {effort}: no drafts were verified")
            check(output >= MTP_MIN_OUTPUT_TOKENS, f"effort {effort}: only {output} tokens")
            check(
                speed >= required,
                f"effort {effort}: decode {speed:.1f} tok/s < {required:.1f} "
                f"({MTP_SPEEDUP_REQUIRED}x B0-10 plain)",
            )
            results.append(f"{effort} {speed:.1f} tok/s (accept {rate:.2f})")
        self.record("speculative", passed=True)
        emit(
            "READY",
            f"Speculative decoding passed: {'; '.join(results)}; "
            f"B0-10 plain {B0_PLAIN_DECODE_TOK_S} tok/s.",
        )

    def edit_request(self, history: list[dict]) -> dict:
        source = EDIT_FILE.read_text()
        instruction = (
            "Here is a Python file:\n\n```python\n" + source + "```\n\n"
            "Rewrite the complete file with the class `Codec` renamed to `TokenCodec` "
            "everywhere and nothing else changed. Output only the complete file in one "
            "code block."
        )
        return self.request(
            [*history, user(instruction)], reasoning={"effort": "none"}, max_output_tokens=1200
        )

    async def edit(self, client, body: dict) -> dict:
        """Streams a code edit; returns the worker's metrics for it plus the output length."""
        response, _ = await self.stream(client, body)
        status = response["status"]
        check(status in ("completed", "incomplete"), f"status {status}")
        last = (await self.runtime(client))["worker"]["last"]
        return {
            "output_tokens": response["usage"]["output_tokens"],
            "decode_tok_s": last.get("decode_tok_s") or 0,
            "lookup_rounds": last.get("lookup_rounds") or 0,
            "lookup_accept_rate": last.get("lookup_accept_rate"),
            "mtp_accept_rate": last.get("mtp_accept_rate"),
        }

    async def lookup(self, client):
        result = await self.edit(client, self.edit_request([]))
        required = B0_PLAIN_DECODE_TOK_S * LOOKUP_SPEEDUP_REQUIRED
        self.record("lookup.edit", **result)
        check(result["lookup_rounds"] > 0, "no prompt-lookup drafts were verified")
        check(
            result["output_tokens"] >= LOOKUP_MIN_OUTPUT_TOKENS,
            f"only {result['output_tokens']} tokens",
        )
        check(
            result["decode_tok_s"] >= required,
            f"decode {result['decode_tok_s']:.1f} tok/s < {required:.1f} "
            f"({LOOKUP_SPEEDUP_REQUIRED}x B0-10 plain)",
        )
        self.record("lookup", passed=True)
        emit(
            "READY",
            f"Prompt lookup passed: code edit at {result['decode_tok_s']:.1f} tok/s "
            f"({result['lookup_rounds']} lookup rounds, accept "
            f"{result['lookup_accept_rate']}); B0-10 plain {B0_PLAIN_DECODE_TOK_S} tok/s.",
        )

    async def structured(self, client):
        fmt = {"type": "json_schema", "name": "city", "schema": CITY_SCHEMA, "strict": True}
        for effort in ("none", "medium"):
            body = self.request(
                [user("Describe the city of Paris as a JSON object.")],
                reasoning={"effort": effort},
                max_output_tokens=2048,
                text={"format": fmt},
            )
            response, _ = await self.stream(client, body)
            check(response["status"] == "completed", f"effort {effort}: {response['status']}")
            messages = [i for i in response["output"] if i["type"] == "message"]
            check(len(messages) == 1, f"effort {effort}: {len(messages)} answer messages")
            text = "".join(part["text"] for part in messages[0]["content"])
            try:
                value = json.loads(text)
            except ValueError:
                raise Failure(f"effort {effort}: the answer is not JSON") from None
            violation = value_violation(value, CITY_SCHEMA)
            check(violation is None, f"effort {effort}: {violation}")
            self.record(f"structured.{effort}", **_usage(response["usage"]))
        tool = {
            "type": "function",
            "name": "record_city",
            "description": "Record facts about a city.",
            "parameters": CITY_SCHEMA,
            "strict": True,
        }
        body = self.request(
            [
                user(
                    "Call the record_city tool for Paris: population 2100000, capital, "
                    "languages French, size large, mayor unknown (null). Call the tool."
                )
            ],
            tools=[tool],
            reasoning={"effort": "none"},
            max_output_tokens=1024,
        )
        response, _ = await self.stream(client, body)
        check(response["status"] == "completed", f"strict call: {response['status']}")
        calls = [i for i in response["output"] if i["type"] == "function_call"]
        check(calls, "the model did not call the strict tool")
        for call in calls:
            violation = value_violation(json.loads(call["arguments"]), CITY_SCHEMA)
            check(violation is None, f"strict call: {violation}")
        self.record("structured", passed=True)
        emit("READY", "Structured output passed: text.format (none, medium) and a strict call.")

    async def images(self, client):
        def picture(content: list[dict]) -> dict:
            return {"type": "message", "role": "user", "content": content}

        question = (
            "What colour is the circle, and what word is written in the picture? "
            "Answer with just the colour and the word."
        )
        key = f"validate-images-{time.time_ns()}"
        body = self.request(
            [
                picture(
                    [
                        {"type": "input_text", "text": question},
                        {"type": "input_image", "image_url": _picture("MANGO", (210, 30, 30))},
                    ]
                )
            ],
            reasoning={"effort": "none"},
            max_output_tokens=64,
            prompt_cache_key=key,
        )
        response, ttft = await self.stream(client, body)
        check(response["status"] == "completed", f"status {response['status']}")
        answer = _answer(response).lower()
        check("red" in answer and "mango" in answer, "the colour or the word was not read")
        first = (await self.runtime(client))["worker"]["last"]
        again, _ = await self.stream(client, body)
        cached = again["usage"]["input_tokens_details"]["cached_tokens"]
        check(cached == again["usage"]["input_tokens"], f"the same picture: {cached} cached")
        other = {
            **body,
            "input": [
                picture(
                    [
                        {"type": "input_text", "text": question},
                        {"type": "input_image", "image_url": _picture("LEMON", (30, 30, 210))},
                    ]
                )
            ],
        }
        third, _ = await self.stream(client, other)
        check(_answer(third).lower().count("lemon") > 0, "the second picture was not read")
        other_cached = third["usage"]["input_tokens_details"]["cached_tokens"]
        check(other_cached < third["usage"]["input_tokens"], "another picture reused the cache")
        # a picture returned by a tool
        call = {"type": "function_call", "call_id": "shot", "name": "screenshot", "arguments": "{}"}
        output = {
            "type": "function_call_output",
            "call_id": "shot",
            "output": [
                {"type": "input_text", "text": "Screenshot:"},
                {"type": "input_image", "image_url": _picture("PLUM", (40, 160, 40))},
            ],
        }
        tool = {
            "type": "function",
            "name": "screenshot",
            "description": "Capture the screen.",
            "parameters": {"type": "object", "properties": {}},
        }
        shot, _ = await self.stream(
            client,
            self.request(
                [user("Take a screenshot and tell me what word it shows."), call, output],
                tools=[tool],
                tool_choice="none",
                reasoning={"effort": "none"},
                max_output_tokens=64,
            ),
        )
        check("plum" in _answer(shot).lower(), "the word in the tool's picture was not read")
        self.record(
            "images",
            passed=True,
            ttft_ms=round((ttft or 0) * 1000),
            image_tokens=first.get("image_tokens"),
            vision_encode_ms=first.get("vision_encode_ms"),
            prefill_tok_s=first.get("prefill_tok_s"),
            cached_again=cached,
            cached_other=other_cached,
            **_usage(response["usage"]),
        )
        emit(
            "READY",
            f"Images passed: read a picture ({first.get('image_tokens')} image tokens, encoded "
            f"in {first.get('vision_encode_ms')} ms) and a tool's picture; the cache tells "
            "pictures apart.",
        )

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

    def long_request(self, chars: int, key: str) -> dict:
        return self.request(
            [user(_corpus(chars) + LONG_QUESTION)],
            reasoning={"effort": "none"},
            max_output_tokens=256,
            prompt_cache_key=key,
        )

    async def long_prompt(self, client, tokens: int, key: str) -> tuple[dict, int, int]:
        """(request, its input tokens, corpus characters) for a prompt of about `tokens`."""
        emit("WAIT", f"Building a prompt of about {tokens} tokens...")
        chars = tokens * 3
        for _ in range(3):
            body = self.long_request(chars, key)
            counted = await client.post(
                f"{self.base}/v1/responses/input_tokens", json=body, headers=self.headers
            )
            check(counted.status_code == 200, "token counting failed")
            count = counted.json()["input_tokens"]
            if abs(count - tokens) <= tokens * 0.02:
                break
            chars = int(chars * tokens / count)
        return body, count, chars

    async def long_context(self, client, tokens: int):
        key = f"validate-long-{time.time_ns()}"
        body, count, _ = await self.long_prompt(client, tokens, key)
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
        # Decode speed at this context: a longer answer continuing the same session.
        answer = {
            **follow,
            "input": [
                *follow["input"],
                *as_input(second["output"]),
                user("Now describe the text in detail, in about 200 words."),
            ],
        }
        third, _ = await self.stream(client, answer)
        decoded = (await self.runtime(client))["worker"]["last"]
        decode_speed = decoded.get("decode_tok_s") or 0
        decode_reference = _reference(count, B0_DECODE)
        long_output = third["usage"]["output_tokens"]
        # A code edit on the same context: prompt lookup at long context (B2-3).
        edit_history = [*answer["input"], *as_input(third["output"])]
        edited = await self.edit(client, self.edit_request(edit_history))
        edit_required = decode_reference * LOOKUP_SPEEDUP_REQUIRED
        self.record(
            "long_context",
            passed=ratio >= PREFILL_RATIO_REQUIRED
            and cached >= first["usage"]["input_tokens"]
            and swap_growth < SWAP_GROWTH_ALLOWED
            and long_output >= LONG_DECODE_MIN_TOKENS
            and decode_speed >= decode_reference
            and edited["lookup_rounds"] > 0
            and edited["decode_tok_s"] >= edit_required,
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
            decode_output_tokens=long_output,
            decode_tok_s=decode_speed,
            b0_plain_decode_tok_s=round(decode_reference, 1),
            mtp_accept_rate=decoded.get("mtp_accept_rate"),
            edit_output_tokens=edited["output_tokens"],
            edit_decode_tok_s=edited["decode_tok_s"],
            edit_lookup_rounds=edited["lookup_rounds"],
            edit_lookup_accept_rate=edited["lookup_accept_rate"],
        )
        check(
            ratio >= PREFILL_RATIO_REQUIRED,
            f"prefill {speed:.0f} tok/s is {ratio:.0%} of B0-5's {reference:.0f}",
        )
        check(cached >= first["usage"]["input_tokens"], f"continuation cached {cached}")
        check(swap_growth < SWAP_GROWTH_ALLOWED, f"swap grew by {swap_growth / 1024**2:.0f} MiB")
        check(long_output >= LONG_DECODE_MIN_TOKENS, f"long answer had {long_output} tokens")
        check(
            decode_speed >= decode_reference,
            f"decode {decode_speed:.1f} tok/s at {count} tokens is below B0-5 plain "
            f"{decode_reference:.1f}",
        )
        check(edited["lookup_rounds"] > 0, "long-context code edit used no lookup drafts")
        check(
            edited["decode_tok_s"] >= edit_required,
            f"long-context code edit {edited['decode_tok_s']:.1f} tok/s < {edit_required:.1f}",
        )
        emit(
            "READY",
            f"Long context passed: {count} tokens at {speed:.0f} tok/s ({ratio:.0%} of B0-5 "
            f"compute-only {reference:.0f}); continuation TTFT {ttft_warm or 0:.2f}s; "
            f"decode {decode_speed:.1f} tok/s (B0-5 plain {decode_reference:.1f}); "
            f"code edit {edited['decode_tok_s']:.1f} tok/s with lookup; "
            f"swap growth {swap_growth / 1024**2:.0f} MiB.",
        )

    def default_checks(self, client) -> list:
        return [
            ("ready", self.ready(client)),
            ("text", self.text(client)),
            ("thinking", self.thinking(client)),
            ("tool_call", self.tool_call(client)),
            ("prompt_cache", self.prompt_cache(client)),
            ("websocket", self.websocket(client)),
            ("effort_switch", self.effort_switch(client)),
            ("speculative", self.speculative(client)),
            ("lookup", self.lookup(client)),
            ("structured", self.structured(client)),
            ("images", self.images(client)),
            ("runtime", self.runtime_status(client)),
        ]

    async def restart_prepare(self, client, tokens: int):
        key = f"validate-restart-{time.time_ns()}"
        body, count, chars = await self.long_prompt(client, tokens, key)
        emit("WAIT", f"Cold prefill of {count} tokens (this takes several minutes)...")
        response, ttft = await self.stream(client, body)
        check(response["status"] == "completed", f"status {response['status']}")
        last = (await self.runtime(client))["worker"]["last"]
        record = {
            "key": key,
            "chars": chars,
            "input_tokens": response["usage"]["input_tokens"],
            "prompt_sha256": _digest(body),
            "cold_ttft_ms": round((ttft or 0) * 1000),
            "prefill_tok_s": last.get("prefill_tok_s"),
        }
        RESTART_RECORD.parent.mkdir(parents=True, exist_ok=True)
        RESTART_RECORD.write_text(json.dumps(record))
        RESTART_RECORD.chmod(0o600)
        numbers = {k: v for k, v in record.items() if k not in ("key", "prompt_sha256")}
        self.record("restart_prepare", passed=True, **numbers)
        emit(
            "READY",
            f"Session of {record['input_tokens']} tokens built (cold TTFT "
            f"{record['cold_ttft_ms'] / 1000:.1f}s). Now run ./backend_service.sh restart, "
            "then this script with --restart-resume.",
        )

    async def restart_resume(self, client):
        check(RESTART_RECORD.is_file(), "no session recorded: run --restart-prepare first")
        record = json.loads(RESTART_RECORD.read_text())
        body = self.long_request(record["chars"], record["key"])
        check(
            _digest(body) == record["prompt_sha256"],
            "the prompt changed since --restart-prepare (repository files differ): prepare again",
        )
        response, ttft = await self.stream(client, body)
        check(response["status"] == "completed", f"status {response['status']}")
        last = (await self.runtime(client))["worker"]["last"]
        cached = response["usage"]["input_tokens_details"]["cached_tokens"]
        ttft = ttft or 0
        passed = (
            last.get("restore_path") == "ssd"
            and cached == response["usage"]["input_tokens"]
            and ttft <= RESTART_TTFT_REQUIRED_S
        )
        self.record(
            "restart_resume",
            passed=passed,
            input_tokens=response["usage"]["input_tokens"],
            cached_tokens=cached,
            ttft_ms=round(ttft * 1000),
            cold_ttft_ms=record["cold_ttft_ms"],
            ssd_load_ms=last.get("ssd_load_ms"),
            peak_memory_bytes=last.get("peak_memory_bytes"),
            swap_growth_bytes=last.get("swap_growth_bytes"),
        )
        check(last.get("restore_path") == "ssd", f"restore path {last.get('restore_path')}")
        check(cached == response["usage"]["input_tokens"], f"only {cached} tokens cached")
        check(ttft <= RESTART_TTFT_REQUIRED_S, f"first token after {ttft:.1f}s")
        emit(
            "READY",
            f"Restart restore passed: {cached} tokens from SSD in {last.get('ssd_load_ms')} ms, "
            f"first token after {ttft:.2f}s (cold: {record['cold_ttft_ms'] / 1000:.1f}s).",
        )


def _picture(word: str, colour: tuple[int, int, int]) -> str:
    """A 1024x512 PNG data URL: a coloured circle and a word in large black letters."""
    import base64
    import io

    from PIL import Image, ImageDraw, ImageFont

    image = Image.new("RGB", (1024, 512), "white")
    draw = ImageDraw.Draw(image)
    draw.ellipse((60, 106, 360, 406), fill=colour)
    draw.text((440, 200), word, fill="black", font=ImageFont.load_default(size=120))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


def _answer(response: dict) -> str:
    return "".join(
        part.get("text", "")
        for item in response["output"]
        if item["type"] == "message"
        for part in item["content"]
    )


def _digest(body: dict) -> str:
    return hashlib.sha256(json.dumps(body["input"], sort_keys=True).encode()).hexdigest()


def _usage(usage: dict) -> dict:
    return {
        "input_tokens": usage["input_tokens"],
        "cached_tokens": usage["input_tokens_details"]["cached_tokens"],
        "output_tokens": usage["output_tokens"],
        "reasoning_tokens": usage["output_tokens_details"]["reasoning_tokens"],
    }


def _reference(tokens: int, points=B0_PREFILL) -> float:
    """A B0-5 speed (prefill by default), interpolated in log(context length)."""
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
    restart = parser.add_mutually_exclusive_group()
    restart.add_argument(
        "--restart-prepare", type=int, metavar="TOKENS", help="B2-1, before a restart"
    )
    restart.add_argument("--restart-resume", action="store_true", help="B2-1, after a restart")
    args = parser.parse_args()
    for name in ("long", "restart_prepare"):
        value = getattr(args, name)
        if value is not None and not 4096 <= value <= 250_000:
            emit("ERROR", f"--{name.replace('_', '-')} must be between 4096 and 250000 tokens.")
            return 2
    if args.long is not None and (args.restart_prepare is not None or args.restart_resume):
        emit("ERROR", "--long does not combine with the restart checks.")
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
        if args.restart_prepare is not None:
            checks = [
                ("ready", validator.ready(client)),
                ("restart_prepare", validator.restart_prepare(client, args.restart_prepare)),
            ]
        elif args.restart_resume:
            checks = [
                ("ready", validator.ready(client)),
                ("restart_resume", validator.restart_resume(client)),
            ]
        else:
            checks = validator.default_checks(client)
        for name, coroutine in checks:
            timeout = LONG_TIMEOUT_S if name.startswith("restart") else TIMEOUT_S
            await validator.run(name, coroutine, timeout)
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
