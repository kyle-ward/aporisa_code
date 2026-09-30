"""Turns worker item messages into protocol stream events (docs/protocol.md 7.3).

The gateway owns every id (resp_, msg_, rs_, fc_, call_) and every sequence_number; the
worker only reports item kinds, text deltas and the authoritative finished item. The
assembler checks its own output (one item at a time, deltas add up to the done text) and
raises AssemblyError instead of emitting an invalid stream.
"""

from __future__ import annotations

import secrets
import time


class AssemblyError(Exception):
    """The worker's messages would produce a stream that violates section 7.3."""


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(12)}"


class Assembler:
    def __init__(self, response_id: str, model: str):
        self.response = {
            "id": response_id,
            "object": "response",
            "created_at": int(time.time()),
            "model": model,
        }
        self.sequence = 0
        self.output: list[dict] = []
        self.current: dict | None = None
        self.finished = False

    def _emit(self, event: dict) -> dict:
        if self.finished:
            raise AssemblyError("event after the terminal event")
        event["sequence_number"] = self.sequence
        self.sequence += 1
        return event

    def _snapshot(self, status: str, **extra) -> dict:
        return {
            **self.response,
            "status": status,
            "output": list(self.output),
            "usage": None,
            "incomplete_details": None,
            "error": None,
            **extra,
        }

    def created(self) -> dict:
        return self._emit({"type": "response.created", "response": self._snapshot("in_progress")})

    def item_added(self, kind: str, name: str | None = None) -> list[dict]:
        if self.current is not None:
            raise AssemblyError("items must not interleave")
        index = len(self.output)
        if kind == "message":
            item = {"type": "message", "id": new_id("msg"), "role": "assistant", "content": []}
        elif kind == "reasoning":
            item = {
                "type": "reasoning",
                "id": new_id("rs"),
                "summary": [],
                "content": [],
                "encrypted_content": None,
            }
        elif kind == "function_call":
            if not name:
                raise AssemblyError("function_call needs a name when it starts")
            item = {
                "type": "function_call",
                "id": new_id("fc"),
                "call_id": new_id("call"),
                "name": name,
                "arguments": "",
            }
        else:
            raise AssemblyError(f"unknown item kind {kind!r}")
        self.current = {"item": item, "index": index, "text": ""}
        events = [
            self._emit(
                {"type": "response.output_item.added", "output_index": index, "item": dict(item)}
            )
        ]
        if kind == "message":
            events.append(
                self._emit(
                    {
                        **self._ref(),
                        "type": "response.content_part.added",
                        "part": {"type": "output_text", "text": ""},
                    }
                )
            )
        return events

    def _ref(self, content: bool = True) -> dict:
        item = self.current["item"]
        ref = {"item_id": item["id"], "output_index": self.current["index"]}
        if content and item["type"] != "function_call":
            ref["content_index"] = 0
        return ref

    def delta(self, text: str) -> list[dict]:
        if self.current is None:
            raise AssemblyError("delta outside an item")
        if not text:
            return []
        self.current["text"] += text
        kind = self.current["item"]["type"]
        event_type = {
            "message": "response.output_text.delta",
            "reasoning": "response.reasoning_text.delta",
            "function_call": "response.function_call_arguments.delta",
        }[kind]
        return [self._emit({"type": event_type, **self._ref(), "delta": text})]

    def item_done(self, worker_item: dict) -> list[dict]:
        if self.current is None:
            raise AssemblyError("item_done outside an item")
        item, text, index = self.current["item"], self.current["text"], self.current["index"]
        if worker_item.get("type") != item["type"]:
            raise AssemblyError("item_done does not match the started item")
        ref = self._ref()
        events: list[dict] = []
        if item["type"] == "message":
            final = worker_item["content"][0]["text"] if worker_item.get("content") else ""
            if final != text:
                raise AssemblyError("message text differs from its deltas")
            part = {"type": "output_text", "text": final}
            events.append(self._emit({"type": "response.output_text.done", **ref, "text": final}))
            events.append(self._emit({"type": "response.content_part.done", **ref, "part": part}))
            done = {**item, "content": [part]}
            if worker_item.get("phase") in ("commentary", "final_answer"):
                done["phase"] = worker_item["phase"]
        elif item["type"] == "reasoning":
            final = worker_item["content"][0]["text"] if worker_item.get("content") else ""
            if final != text:
                raise AssemblyError("reasoning text differs from its deltas")
            events.append(
                self._emit({"type": "response.reasoning_text.done", **ref, "text": final})
            )
            done = {**item, "content": [{"type": "reasoning_text", "text": final}]}
        else:
            final = worker_item["arguments"]
            if final != text or worker_item.get("name") != item["name"]:
                raise AssemblyError("function call differs from its start or deltas")
            events.append(
                self._emit(
                    {"type": "response.function_call_arguments.done", **ref, "arguments": final}
                )
            )
            done = {**item, "arguments": final}
        self.output.append(done)
        self.current = None
        events.append(
            self._emit({"type": "response.output_item.done", "output_index": index, "item": done})
        )
        return events

    def terminal(
        self,
        status: str,
        *,
        usage: dict | None = None,
        reason: str | None = None,
        error: dict | None = None,
    ) -> dict:
        """Ends the stream; an unfinished item is discarded (interrupt, failure, budget)."""
        self.current = None
        event_type = {
            "completed": "response.completed",
            "incomplete": "response.incomplete",
            "failed": "response.failed",
        }[status]
        extra: dict = {"usage": usage}
        if status == "incomplete":
            extra["incomplete_details"] = {"reason": reason}
        if status == "failed":
            extra["error"] = error
        event = self._emit({"type": event_type, "response": self._snapshot(status, **extra)})
        self.finished = True
        return event
