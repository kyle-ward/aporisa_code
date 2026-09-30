"""An in-process fake worker with the WorkerClient interface.

Behaves like the frontend mock engine (aporisa_code/src/mock/engine.ts): echoes the last
user text, counts ~4 bytes per token over canonical request segments, reports prefix-cache
hits per session, honours prewarm, interrupts, the output budget and the section 6.1
effective effort. Used by gateway tests and to run the wire conformance suite without a
model; never imported by production code paths.
"""

from __future__ import annotations

import asyncio
import json
import math
from collections.abc import AsyncIterator, Callable

from ..configs.models import ModelProfile, public_model
from ..gateway.worker_client import Job, WorkerClient
from ..protocol.validation import effective_effort

Script = Callable[[dict, int], list[dict]]


def tokens_of(text: str) -> int:
    return math.ceil(len(text.encode()) / 4)


def last_user_text(items: list[dict]) -> str:
    for item in reversed(items):
        if item["type"] == "message" and item["role"] == "user":
            return "".join(
                part.get("text", "") for part in item["content"] if part["type"] == "input_text"
            )
    return ""


def echo_script(params: dict, _index: int) -> list[dict]:
    return [
        {
            "type": "message",
            "text": f"echo: {last_user_text(params['input'])}",
            "phase": "final_answer",
        }
    ]


def _canonical(value) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def segments(params: dict) -> list[str]:
    items = [{k: v for k, v in item.items() if k != "id"} for item in params["input"]]
    return [
        _canonical({"instructions": params.get("instructions", "")}),
        _canonical({"tools": params.get("tools", [])}),
        *(_canonical(item) for item in items),
    ]


class FakeWorker(WorkerClient):
    def __init__(
        self,
        profile: ModelProfile,
        alias: str = "aporisa-local-v0",
        *,
        script: Script = echo_script,
        chunk_size: int = 8,
        chunk_delay_s: float = 0.0,
        fail_start: bool = False,
    ):
        self.model = public_model(alias, profile)
        self.script, self.chunk_size, self.chunk_delay_s = script, chunk_size, chunk_delay_s
        self.fail_start = fail_start
        self.running = False
        self.cache: dict[str, list[str]] = {}
        self.interrupts: set[str] = set()
        self.active: set[str] = set()
        self.requests: list[dict] = []
        self.released: list[str] = []
        self.index = 0

    async def start(self) -> None:
        if self.fail_start:
            raise RuntimeError("fake worker configured to fail")
        self.running = True

    async def close(self) -> None:
        self.running = False

    @property
    def alive(self) -> bool:
        return self.running

    def kill(self) -> None:
        """Simulates a worker crash for recovery tests."""
        self.running = False

    async def count_tokens(self, request: dict) -> int:
        return sum(tokens_of(s) for s in segments(request))

    async def interrupt(self, job_id: str) -> None:
        if job_id in self.active:
            self.interrupts.add(job_id)

    async def release_session(self, session: str) -> None:
        self.released.append(session)
        self.cache.pop(session, None)

    async def status(self) -> dict:
        return {"sessions": len(self.cache), "active": len(self.active)}

    def _cached(self, session: str | None, parts: list[str]) -> int:
        previous = (
            self.cache.get(session)
            if session and self.model["capabilities"]["prompt_cache"]
            else None
        )
        cached = 0
        for index, part in enumerate(parts):
            if not previous or index >= len(previous) or previous[index] != part:
                break
            cached += tokens_of(part)
        return cached

    def _plan(self, params: dict) -> list[dict]:
        steps = self.script(params, self.index)
        self.index += 1
        effort = effective_effort(params, self.model)
        kept = []
        for step in steps:
            if step["type"] == "reasoning" and effort == "none":
                continue
            is_call = step["type"] in ("function_call", "malformed_tool_call")
            if is_call and params.get("tool_choice") == "none":
                continue
            kept.append(step)
        if params.get("parallel_tool_calls") is not True:
            calls = [i for i, s in enumerate(kept) if s["type"] == "function_call"]
            if calls:
                kept = kept[: calls[0] + 1]
        return kept

    async def generate(self, job: Job) -> AsyncIterator[dict]:
        params = job.request
        self.active.add(job.id)
        try:
            parts = segments(params)
            input_tokens = sum(tokens_of(s) for s in parts)
            reserve = params.get("max_output_tokens", self.model["max_output_tokens"])
            if input_tokens + reserve > self.model["context_window"]:
                yield {"type": "rejected", "code": "context_length_exceeded"}
                return
            self.requests.append(params)
            cached = min(self._cached(job.session, parts), input_tokens)
            yield {
                "type": "accepted",
                "input_tokens": input_tokens,
                "cached_tokens": cached,
                "restore_path": "live" if cached else "cold",
            }
            if job.session:
                self.cache[job.session] = parts
            budget = params.get("max_output_tokens", self.model["max_output_tokens"])
            output_tokens = reasoning_tokens = 0

            def usage() -> dict:
                return {
                    "input_tokens": input_tokens,
                    "input_tokens_details": {"cached_tokens": cached},
                    "output_tokens": output_tokens,
                    "output_tokens_details": {"reasoning_tokens": reasoning_tokens},
                    "total_tokens": input_tokens + output_tokens,
                }

            if params.get("generate") is False:
                yield {"type": "finished", "status": "completed", "usage": usage()}
                return
            for step in self._plan(params):
                kind = step["type"]
                if kind == "malformed_tool_call":
                    # Broken markup: optionally after the call already started streaming.
                    if step.get("name"):
                        yield {"type": "item_added", "kind": "function_call", "name": step["name"]}
                        yield {"type": "delta", "text": '{"cmd":'}
                    yield {"type": "failed", "code": "tool_call_invalid", "detail": step["detail"]}
                    return
                yield {"type": "item_added", "kind": kind, "name": step.get("name")}
                payload = step["arguments"] if kind == "function_call" else step["text"]
                emitted = ""
                stop = None
                for start in range(0, len(payload), self.chunk_size):
                    if self.chunk_delay_s:
                        await asyncio.sleep(self.chunk_delay_s)
                    if job.id in self.interrupts:
                        stop = "interrupted"
                        break
                    chunk = payload[start : start + self.chunk_size]
                    cost = tokens_of(chunk)
                    if cost > budget - output_tokens:
                        stop = "max_output_tokens"
                        break
                    output_tokens += cost
                    if kind == "reasoning":
                        reasoning_tokens += cost
                    emitted += chunk
                    yield {"type": "delta", "text": chunk}
                if stop:
                    yield {
                        "type": "finished",
                        "status": "incomplete",
                        "reason": stop,
                        "usage": usage(),
                    }
                    return
                if kind == "message":
                    item = {
                        "type": "message",
                        "content": [{"type": "output_text", "text": emitted}],
                    }
                    if step.get("phase"):
                        item["phase"] = step["phase"]
                elif kind == "reasoning":
                    item = {
                        "type": "reasoning",
                        "content": [{"type": "reasoning_text", "text": emitted}],
                    }
                else:
                    item = {"type": "function_call", "name": step["name"], "arguments": emitted}
                yield {"type": "item_done", "item": item}
            yield {"type": "finished", "status": "completed", "usage": usage()}
        finally:
            self.active.discard(job.id)
            self.interrupts.discard(job.id)
