"""Model adapter for Qwen3.8-Flash-Next (DEVELOPMENT_PLAN.md 5.2-5.4, 6.5, 14.5).

- render(): protocol request -> prompt token ids. The text is exactly what the official
  chat_template.jinja (revision 236dfdf) produces with preserve_thinking=true, except for the
  documented extensions the template lacks: mid-history `developer` and
  `configuration_update` render as system segments. Blocks are tokenized one at a time;
  every block boundary sits right before an added token (`<|im_start|>`), so the result
  equals whole-string tokenization.
- Images (B2-6, engine/vision.py): an input_image in a user message or tool output renders
  as the template's `<|vision_start|><|image_pad|><|vision_end|>`, with the pad expanded to
  the image's token count (what the model's processor does to the template text). The
  plan carries the images' positions, M-RoPE position ids and the key sequence caches
  compare (the image's digest in place of its first pad).
- TokenMap: rendered assistant-turn text -> the token ids actually generated, so a
  re-rendered history reproduces the live cache exactly (6.5).
- Parser: generated token ids -> worker item messages, incrementally.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import secrets
import threading
from collections import OrderedDict
from dataclasses import dataclass, field

import numpy as np

from ..tokens import Codec
from ..vision import (
    IMAGE_PAD,
    VISION_END,
    VISION_IDS,
    VISION_START,
    ImageError,
    ImagePolicy,
    ImageSpec,
    describe,
    positions,
)

THINK_OPEN, THINK_CLOSE = 248068, 248069
CALL_OPEN, CALL_CLOSE = 248058, 248059
IM_START, IM_END, END_OF_TEXT = 248045, 248046, 248044
STOP_IDS = frozenset({IM_END, END_OF_TEXT})
NAME_RULE = re.compile(r"[A-Za-z0-9_-]{1,64}")

# Official template sentences (xhigh, low); medium and none have no official text and use
# the B0-12 wording. Baseline: only at the head of the system block. Updates: mid-history.
XHIGH_TEXT = (
    "Reasoning effort is set to xhigh. Please think carefully through the task, validate key "
    "assumptions, consider plausible alternatives, and prioritize correctness, consistency, "
    "and clarity in the final answer."
)
LOW_TEXT = (
    "Reasoning effort is set to low. Keep your thinking brief and focused, moving directly to "
    "the conclusion without unnecessary elaboration."
)
BASELINE_TEXT = {"high": XHIGH_TEXT, "low": LOW_TEXT, "medium": "", "none": ""}
UPDATE_TEXT = {
    "high": XHIGH_TEXT,
    "low": LOW_TEXT,
    "medium": "Reasoning effort is set to medium.",
    "none": "Reasoning is disabled from here on; answer directly.",
}
TOOLS_HEADER = "# Tools\n\nYou have access to the following functions:\n\n<tools>"
TOOLS_FOOTER = (
    "\n</tools>\n\nIf you choose to call a function ONLY reply in the following format with NO "
    "suffix:\n\n<tool_call>\n<function=example_function_name>\n<parameter=example_parameter_1>"
    "\nvalue_1\n</parameter>\n<parameter=example_parameter_2>\nThis is the value for the second "
    "parameter\nthat can span\nmultiple lines\n</parameter>\n</function>\n</tool_call>\n\n"
    "<IMPORTANT>\nReminder:\n- Function calls MUST follow the specified format: an inner "
    "<function=...></function> block must be nested within <tool_call></tool_call> XML tags\n"
    "- Required parameters MUST be specified\n- You may provide optional reasoning for your "
    "function call in natural language BEFORE the function call, but NOT after\n- If there is "
    "no function call available, answer the question like normal with your current knowledge "
    "and do not tell the user about function calls\n</IMPORTANT>"
)
# text.format (protocol 8.4): told to the model as a system segment right before the
# generation prompt, so the history's prefix stays cacheable; decoding also enforces it.
FORMAT_TEXT = (
    "Answer with a single JSON value and nothing else (no code fence, no commentary). "
    "It must follow this JSON schema:\n{schema}"
)

GENERATION_PROMPT = {
    True: "<|im_start|>assistant\n<think>\n",
    False: "<|im_start|>assistant\n<think>\n\n</think>\n\n",
}


@dataclass(frozen=True)
class Sampling:
    temperature: float
    top_p: float
    top_k: int
    min_p: float
    presence_penalty: float


# Model card values (DEVELOPMENT_PLAN.md 5.4, D-11).
THINKING = Sampling(temperature=1.0, top_p=0.95, top_k=20, min_p=0.0, presence_penalty=0.0)
NON_THINKING = Sampling(temperature=0.7, top_p=0.8, top_k=20, min_p=0.0, presence_penalty=1.5)


@dataclass
class RenderPlan:
    tokens: list[int]
    boundaries: list[int]  # token offsets where an input item group ends (ascending)
    prompt_start: int  # offset of the generation prompt
    effort: str
    thinking: bool
    sampling: Sampling
    max_output_tokens: int
    banned_ids: tuple[int, ...]
    stop_after_call: bool
    tool_schemas: dict[str, dict] = field(default_factory=dict)
    text_format: dict | None = None  # the text.format schema (protocol 8.4)
    strict_schemas: dict[str, dict] = field(default_factory=dict)  # strict function tools
    # Images (B2-6): (offset of the first pad, spec) in prompt order; the sequence caches
    # compare (tokens, except each image's first pad); M-RoPE positions [3, len] and the
    # shift that positions generated tokens (None and 0 without images).
    images: list[tuple[int, ImageSpec]] = field(default_factory=list)
    keys: list[int] | None = None
    positions: np.ndarray | None = None
    position_shift: int = 0

    @property
    def generation_prompt(self) -> list[int]:
        return self.tokens[self.prompt_start :]

    @property
    def cache_keys(self) -> list[int]:
        return self.keys if self.keys is not None else self.tokens

    @property
    def image_tokens(self) -> int:
        return sum(spec.tokens for _, spec in self.images)


def _json(value) -> str:
    """Jinja `tojson` as transformers defines it: json.dumps, non-ASCII kept."""
    return json.dumps(value, ensure_ascii=False)


def _text(parts: list[dict] | str) -> str:
    if isinstance(parts, str):
        return parts
    return "".join(part.get("text", "") for part in parts)


IMAGE_MARK = re.compile("\ue000([0-9a-f]{16}):([0-9]+)\ue001")


def _arguments(raw: str) -> dict:
    """function_call.arguments as the mapping the template iterates.

    Native outputs are always JSON objects (protocol 7.1). Anything else cannot be rendered
    by the template; it renders as a call without parameters.
    """
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def render_calls(content: str, calls: list[tuple[str, dict]]) -> str:
    text = ""
    for index, (name, arguments) in enumerate(calls):
        if index == 0:
            text += "\n\n" if content else ""
        else:
            text += "\n"
        text += f"<tool_call>\n<function={name}>\n"
        for key, value in arguments.items():
            rendered = value if isinstance(value, str) else _json(value)
            text += f"<parameter={key}>\n{rendered}\n</parameter>\n"
        text += "</function>\n</tool_call>"
    return text


def assistant_turn(items: list[dict]) -> str:
    """One template assistant message from consecutive assistant-side items, without the
    trailing newline. Several reasoning or message items join with a blank line."""
    reasoning = "\n\n".join(
        _text(item.get("content", [])) for item in items if item["type"] == "reasoning"
    ).strip()
    content = "\n\n".join(
        _text(item["content"]) for item in items if item["type"] == "message"
    ).strip()
    calls = [
        (item["name"], _arguments(item["arguments"]))
        for item in items
        if item["type"] == "function_call"
    ]
    return (
        f"<|im_start|>assistant\n<think>\n{reasoning}\n</think>\n\n{content}"
        + render_calls(content, calls)
        + "<|im_end|>"
    )


def system_segment(text: str) -> str:
    return f"<|im_start|>system\n{text}<|im_end|>\n"


def system_block(request: dict, baseline: str) -> str:
    head = BASELINE_TEXT[baseline]
    instructions = (request.get("instructions") or "").strip()
    tools = request.get("tools") or []
    if tools:
        text = "<|im_start|>system\n" + (head + "\n\n" if head else "") + TOOLS_HEADER
        for tool in tools:
            function = {"name": tool["name"]}
            if "description" in tool:
                function["description"] = tool["description"]
            function["parameters"] = tool["parameters"]
            text += "\n" + _json({"type": "function", "function": function})
        text += TOOLS_FOOTER
        if instructions:
            text += "\n\n" + instructions
        return text + "<|im_end|>\n"
    if instructions:
        return system_segment((head + "\n\n" if head else "") + instructions)
    return system_segment(head) if head else ""


def turn_key(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


class TokenMap:
    """LRU of assistant-turn text -> generated ids; shared by the main and control threads."""

    def __init__(self, max_turns: int = 1024, max_tokens: int = 8 * 1024 * 1024):
        self.max_turns, self.max_tokens = max_turns, max_tokens
        self._entries: OrderedDict[str, tuple[int, ...]] = OrderedDict()
        self._tokens = 0
        self._lock = threading.Lock()

    def get(self, text: str) -> tuple[int, ...] | None:
        key = turn_key(text)
        with self._lock:
            ids = self._entries.get(key)
            if ids is not None:
                self._entries.move_to_end(key)
            return ids

    def put(self, text: str, ids: list[int]) -> None:
        key = turn_key(text)
        with self._lock:
            old = self._entries.pop(key, None)
            if old is not None:
                self._tokens -= len(old)
            self._entries[key] = tuple(ids)
            self._tokens += len(ids)
            while self._entries and (
                len(self._entries) > self.max_turns or self._tokens > self.max_tokens
            ):
                _, dropped = self._entries.popitem(last=False)
                self._tokens -= len(dropped)

    def __len__(self) -> int:
        return len(self._entries)


class Qwen38Adapter:
    def __init__(self, codec: Codec, model: dict, images: ImagePolicy | None = None):
        self.codec, self.model, self.image_policy = codec, model, images
        expected = {
            "<think>": THINK_OPEN,
            "</think>": THINK_CLOSE,
            "<tool_call>": CALL_OPEN,
            "</tool_call>": CALL_CLOSE,
            "<|im_start|>": IM_START,
            "<|im_end|>": IM_END,
            "<|endoftext|>": END_OF_TEXT,
            "<|vision_start|>": VISION_START,
            "<|vision_end|>": VISION_END,
            "<|image_pad|>": IMAGE_PAD,
        }
        for text, token in expected.items():
            if codec.token_id(text) != token:
                raise ValueError(f"tokenizer does not match the adapter: {text}")
        self.newline = codec.encode("\n")

    def effort(self, request: dict) -> tuple[str, str]:
        """(baseline, effective) per protocol 6.1."""
        reasoning = request.get("reasoning")
        baseline = reasoning["effort"] if reasoning else self.model["reasoning"]["default_effort"]
        effective = baseline
        for item in request["input"]:
            if item["type"] == "configuration_update":
                effective = item["reasoning"]["effort"]
        return baseline, effective

    def render(self, request: dict, token_map: TokenMap | None = None) -> RenderPlan:
        """Raises vision.ImageError for an image that cannot be sized (invalid_image)."""
        baseline, effective = self.effort(request)
        tokens: list[int] = []
        boundaries: list[int] = []
        images: list[tuple[int, ImageSpec]] = []
        pending: list[ImageSpec] = []  # images of the block being rendered
        nonce = secrets.token_hex(8)  # image marks can never come from request text

        def content(parts: list[dict] | str, param: str) -> str:
            """The template's render_content: text, and the vision placeholder per image
            (marked here, expanded when the block is tokenized)."""
            if isinstance(parts, str):
                return parts
            text = ""
            for position, part in enumerate(parts):
                if part["type"] != "input_image":
                    text += part.get("text", "")
                    continue
                if self.image_policy is None:
                    raise ImageError(f"{param}[{position}]")
                pending.append(describe(part, f"{param}[{position}]", self.image_policy))
                text += f"\ue000{nonce}:{len(pending) - 1}\ue001"
            return text

        def encode(text: str) -> list[int]:
            ids: list[int] = []
            cursor = 0
            for mark in IMAGE_MARK.finditer(text):
                if mark.group(1) != nonce:
                    continue
                ids.extend(self.codec.encode(text[cursor : mark.start()]))
                spec = pending[int(mark.group(2))]
                ids.append(VISION_START)
                images.append((len(tokens) + len(ids), spec))
                ids.extend([IMAGE_PAD] * spec.tokens)
                ids.append(VISION_END)
                cursor = mark.end()
            ids.extend(self.codec.encode(text[cursor:]))
            pending.clear()
            return ids

        def add(text: str, ids: list[int] | tuple[int, ...] | None = None) -> None:
            if not text and ids is None:
                return
            tokens.extend(encode(text) if ids is None else ids)
            boundaries.append(len(tokens))

        add(system_block(request, baseline))
        group: list[dict] = []
        group_kind = None

        def flush() -> None:
            nonlocal group, group_kind
            if group_kind == "assistant":
                text = assistant_turn(group)
                mapped = token_map.get(text) if token_map is not None else None
                if mapped is not None:
                    add(text + "\n", [*mapped, *self.newline])
                else:
                    add(text + "\n")
            elif group_kind == "tool":
                body = "".join(
                    f"\n<tool_response>\n{content(item['output'], param).strip()}\n</tool_response>"
                    for param, item in group_params
                )
                add(f"<|im_start|>user{body}<|im_end|>\n")
            group, group_kind = [], None
            group_params.clear()

        group_params: list[tuple[str, dict]] = []
        for index, item in enumerate(request["input"]):
            kind = item["type"]
            if kind in ("reasoning", "function_call") or (
                kind == "message" and item["role"] == "assistant"
            ):
                target = "assistant"
            elif kind == "function_call_output":
                target = "tool"
            else:
                target = None
            if target != group_kind:
                flush()
            if target is not None:
                group_kind = target
                group.append(item)
                group_params.append((f"input[{index}].output", item))
                continue
            if kind == "message" and item["role"] == "user":
                text = content(item["content"], f"input[{index}].content").strip()
                add(f"<|im_start|>user\n{text}<|im_end|>\n")
            elif kind == "message" and item["role"] == "developer":
                add(system_segment(_text(item["content"]).strip()))
            elif kind == "configuration_update":
                add(system_segment(UPDATE_TEXT[item["reasoning"]["effort"]]))
            else:
                raise ValueError(f"input item {kind!r} is not supported by this adapter")
        flush()
        fmt = (request.get("text") or {}).get("format")
        if fmt is not None:
            add(system_segment(FORMAT_TEXT.format(schema=_json(fmt["schema"]))))

        thinking = effective != "none"
        prompt_start = len(tokens)
        tokens.extend(self.codec.encode(GENERATION_PROMPT[thinking]))
        # tool_choice none keeps the tool definitions (a stable prefix) and bans the call token.
        # Vision tokens are input only.
        banned = ((CALL_OPEN,) if request.get("tool_choice") == "none" else ()) + tuple(
            sorted(VISION_IDS)
        )
        extra = {}
        if images:
            keys = list(tokens)
            for start, spec in images:
                keys[start] = spec.key
            ids, shift = positions(len(tokens), images)
            extra = {"images": images, "keys": keys, "positions": ids, "position_shift": shift}
        return RenderPlan(
            tokens=tokens,
            boundaries=boundaries,
            prompt_start=prompt_start,
            effort=effective,
            thinking=thinking,
            sampling=THINKING if thinking else NON_THINKING,
            max_output_tokens=request.get("max_output_tokens", self.model["max_output_tokens"]),
            banned_ids=banned,
            stop_after_call=request.get("parallel_tool_calls") is not True,
            tool_schemas={
                tool["name"]: tool["parameters"]
                for tool in request.get("tools") or []
                if tool["type"] == "function"
            },
            text_format=fmt["schema"] if fmt is not None else None,
            strict_schemas={
                tool["name"]: tool["parameters"]
                for tool in request.get("tools") or []
                if tool["type"] == "function" and tool.get("strict") is True
            },
            **extra,
        )

    def parser(self, plan: RenderPlan) -> Parser:
        return Parser(self.codec, plan)

    def record(self, token_map: TokenMap, plan: RenderPlan, items: list[dict], ids: list[int]):
        """Remembers a completed turn: its rendered text -> generation prompt + output ids."""
        if not items:
            return
        turn = [*plan.generation_prompt, *ids]
        if turn[-1] != IM_END:
            # Stopped at </tool_call> (parallel_tool_calls false) or <|endoftext|>: history
            # renders the turn closed by <|im_end|>.
            if turn[-1] == END_OF_TEXT:
                return
            turn.append(IM_END)
        token_map.put(assistant_turn(items), turn)


# --- parser ---------------------------------------------------------------------------------


class _Text:
    """A reasoning or message item whose streamed text equals the template's |trim."""

    def __init__(self, kind: str):
        self.kind, self.started, self.pending, self.text = kind, False, "", ""

    def push(self, text: str) -> list[dict]:
        events: list[dict] = []
        if not self.started:
            text = text.lstrip()
            if not text:
                return events
            self.started = True
            events.append({"type": "item_added", "kind": self.kind})
        combined = self.pending + text
        emit = combined.rstrip()
        self.pending = combined[len(emit) :]
        if emit:
            self.text += emit
            events.append({"type": "delta", "text": emit})
        return events

    def item(self, phase: str | None = None) -> dict | None:
        if not self.started:
            return None
        if self.kind == "reasoning":
            return {"type": "reasoning", "content": [{"type": "reasoning_text", "text": self.text}]}
        item = {"type": "message", "content": [{"type": "output_text", "text": self.text}]}
        if phase:
            item["phase"] = phase
        return item


class CallInvalid(Exception):
    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


_FUNCTION_TAG = "<function="
_NAME = re.compile(r"\s*<function=([^>\n]*)>")
_PARAMETER = re.compile(r"<parameter=([^>\n]*)>")
_PARAMETER_CLOSE = "</parameter>"


def _strict_loads(text: str):
    def reject(_constant):
        raise ValueError("non-finite number")

    return json.loads(text, parse_constant=reject)


def convert(raw: str, schema: dict | None) -> tuple[bool, object]:
    """(converted, value): the parameter text as the JSON value its schema asks for."""
    if not isinstance(schema, dict):
        return False, raw
    if "anyOf" in schema:
        branches = sorted(
            schema["anyOf"], key=lambda b: isinstance(b, dict) and b.get("type") == "string"
        )
        for branch in branches:
            ok, value = convert(raw, branch)
            if ok:
                return True, value
        return False, raw
    kind = schema.get("type")
    text = raw.strip()
    if kind == "string":
        return True, raw
    if kind == "integer" and re.fullmatch(r"-?\d+", text):
        return True, int(text)
    if kind == "number":
        try:
            value = _strict_loads(text)
        except ValueError:
            return False, raw
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
            return True, value
        return False, raw
    if kind == "boolean" and text.lower() in ("true", "false"):
        return True, text.lower() == "true"
    if kind == "null" and text == "null":
        return True, None
    if kind in ("object", "array"):
        try:
            value = _strict_loads(text)
        except ValueError:
            return False, raw
        if isinstance(value, dict if kind == "object" else list):
            return True, value
    return False, raw


class _Call:
    """One <tool_call> body: the name as soon as it is complete, then closed parameters."""

    def __init__(self, schemas: dict[str, dict]):
        self.schemas = schemas
        self.buffer = ""
        self.name: str | None = None
        self.position = 0
        self.arguments: dict = {}
        self.emitted = ""

    def _pending_name(self) -> bool:
        stripped = self.buffer.lstrip()
        if len(stripped) <= len(_FUNCTION_TAG):
            return _FUNCTION_TAG.startswith(stripped)
        if not stripped.startswith(_FUNCTION_TAG):
            return False
        partial = stripped[len(_FUNCTION_TAG) :]
        if len(partial) > 64:
            raise CallInvalid("bad_name")
        return ">" not in partial and "\n" not in partial

    def push(self, text: str) -> list[dict]:
        self.buffer += text
        events: list[dict] = []
        if self.name is None:
            if not self.buffer.strip():
                return events
            match = _NAME.match(self.buffer)
            if match is None:
                if self._pending_name():
                    return events
                raise CallInvalid("no_function")
            if not NAME_RULE.fullmatch(match.group(1)):
                raise CallInvalid("bad_name")
            self.name, self.position = match.group(1), match.end()
            events.append({"type": "item_added", "kind": "function_call", "name": self.name})
        schema = self.schemas.get(self.name, {})
        properties = schema.get("properties", {}) if isinstance(schema, dict) else {}
        while True:
            rest = self.buffer[self.position :]
            opened = _PARAMETER.search(rest)
            if opened is None:
                break
            close = rest.find(_PARAMETER_CLOSE, opened.end())
            if close < 0:
                break
            key, raw = opened.group(1), rest[opened.end() : close]
            raw = raw[1:] if raw.startswith("\n") else raw
            raw = raw[:-1] if raw.endswith("\n") else raw
            if key in self.arguments:
                raise CallInvalid("malformed")
            _, value = convert(raw, properties.get(key))
            self.arguments[key] = value
            piece = ("{" if not self.emitted else ", ") + _json(key) + ": " + _json(value)
            self.emitted += piece
            events.append({"type": "delta", "text": piece})
            self.position += close + len(_PARAMETER_CLOSE)
        return events

    def close(self) -> list[dict]:
        if self.name is None:
            raise CallInvalid(
                "unclosed" if self.buffer.lstrip().startswith(_FUNCTION_TAG) else "no_function"
            )
        if _PARAMETER.search(self.buffer[self.position :]):
            raise CallInvalid("unclosed")
        piece = "}" if self.emitted else "{}"
        self.emitted += piece
        arguments = _json(self.arguments)
        if self.emitted != arguments:
            raise CallInvalid("malformed")
        return [
            {"type": "delta", "text": piece},
            {
                "type": "item_done",
                "item": {"type": "function_call", "name": self.name, "arguments": arguments},
            },
        ]


class Parser:
    """Generated ids -> item_added / delta / item_done messages.

    States: reasoning (thinking mode starts here, the prompt opened <think>) -> answer ->
    call -> after_call (text after a call becomes a new message item). A message's phase is
    commentary when a tool call follows it and final_answer when the turn ends.
    """

    def __init__(self, codec: Codec, plan: RenderPlan):
        self.stream = codec.stream()
        self.schemas = plan.tool_schemas
        self.state = "reasoning" if plan.thinking else "answer"
        self.text: _Text | None = None
        self.call: _Call | None = None
        self.items: list[dict] = []
        self.reasoning_tokens = 0
        self.failed: str | None = None

    def _close_text(self, phase: str | None = None) -> list[dict]:
        text, self.text = self.text, None
        item = text.item(phase) if text else None
        if item is None:
            return []
        self.items.append(item)
        return [{"type": "item_done", "item": item}]

    def _push_text(self, kind: str, text: str) -> list[dict]:
        if self.text is None:
            self.text = _Text(kind)
        return self.text.push(text)

    def _fail(self, error: CallInvalid) -> list[dict]:
        self.failed = error.detail
        return []

    def feed(self, token: int) -> list[dict]:
        """Consumes one non-stop token."""
        if self.failed:
            return []
        state = self.state
        if state == "reasoning":
            self.reasoning_tokens += 1
            if token == THINK_CLOSE:
                self.state = "answer"
                return self._close_text()
        elif token == CALL_OPEN and state in ("answer", "after_call"):
            self.state, self.call = "call", _Call(self.schemas)
            return self._close_text("commentary")
        elif token == CALL_CLOSE and state == "call":
            call, self.call = self.call, None
            self.state = "after_call"
            try:
                events = call.push(self.stream.flush()) + call.close()
            except CallInvalid as error:
                return self._fail(error)
            self.items.append(events[-1]["item"])
            return events
        piece = self.stream.push(token)
        if not piece:
            return []
        if state == "call":
            try:
                return self.call.push(piece)
            except CallInvalid as error:
                return self._fail(error)
        return self._push_text("reasoning" if state == "reasoning" else "message", piece)

    def finish(self) -> list[dict]:
        """The turn ended (stop token, or the first </tool_call> without parallel calls)."""
        if self.failed:
            return []
        tail = self.stream.flush()
        events: list[dict] = []
        if self.state == "call":
            self.failed = "unclosed"
            return []
        if tail:
            kind = "reasoning" if self.state == "reasoning" else "message"
            events += self._push_text(kind, tail)
        return events + self._close_text("final_answer")
