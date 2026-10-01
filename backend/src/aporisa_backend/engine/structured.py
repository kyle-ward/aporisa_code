"""Structured output by constrained decoding (B2-4, docs/protocol.md 8.4), with llguidance.

A request with `text.format` or strict function tools gets one Lark grammar for the answer
(everything after </think>, or from the first token without reasoning). Reasoning is never
constrained. The grammar follows the model's own formats:

- text.format: the answer is either one JSON value of the schema, or tool calls (no
  commentary before them), then <|im_end|>;
- strict tools only: free answer text, then either <|im_end|> or tool calls;
- a strict call is the template's XML with the tool's parameters in schema order, required
  ones present, no others; a string parameter is raw text up to "\\n</parameter>" (what the
  adapter's `convert` reads back as a string), any other type is JSON of its sub-schema;
- a non-strict call keeps a free body; function names are limited to declared tools.

Objects are closed unless their schema says `additionalProperties: true` (8.4). JSON is
written on one line with json.dumps' separators (", ", ": ") and other whitespace is bounded:
with free whitespace a sampled model can pad forever (the random tiny model did, filling
its whole budget with tabs and spaces after `{"ok":`).
"""

from __future__ import annotations

import json

import mlx.core as mx
import numpy as np

from ..protocol.structured import closed
from .adapters.qwen38 import CALL_CLOSE, CALL_OPEN

SPECIAL_OPEN, SPECIAL_CLOSE = f"<[{CALL_OPEN}]>", f"<[{CALL_CLOSE}]>"


def _literal(text: str) -> str:
    return json.dumps(text, ensure_ascii=False)


# llguidance's JSON options: no free whitespace, json.dumps' separators.
_JSON_LAYOUT = {"whitespace_flexible": False, "item_separator": ", ", "key_separator": ": "}


def _json(schema) -> str:
    return "%json " + json.dumps({"x-guidance": _JSON_LAYOUT, **closed(schema)}, ensure_ascii=False)


def _parameter(rule: str, name: str, schema: dict, rules: list[str]) -> str:
    """Rules for one strict parameter; returns the rule name."""
    head = _literal(f"<parameter={name}>\n")
    tail = _literal("\n</parameter>\n")
    bodies: list[str] = []
    for branch in schema["anyOf"] if isinstance(schema.get("anyOf"), list) else [schema]:
        if branch.get("type") == "string" and "enum" not in branch:
            text = f"{rule}_text{len(bodies)}"
            rules.append(f"{text}[stop={_literal(chr(10) + '</parameter>')}]: /(.|\\n)*/")
            bodies.append(f"{text} {_literal(chr(10))}")
        elif branch.get("type") == "string":
            options = " | ".join(_literal(str(option)) for option in branch["enum"])
            bodies.append(f"({options}) {tail}")
        else:
            bodies.append(f"{_json(branch)} {tail}")
    rules.append(f"{rule}: {head} ({' | '.join(bodies)})")
    return rule


def grammar(request: dict) -> str | None:
    """The answer grammar for a request, or None when nothing is constrained."""
    fmt = (request.get("text") or {}).get("format")
    tools = [tool for tool in request.get("tools") or [] if tool["type"] == "function"]
    if request.get("tool_choice") == "none":
        tools = []
    if fmt is None and not any(tool.get("strict") is True for tool in tools):
        return None
    rules: list[str] = []
    calls: list[str] = []
    for index, tool in enumerate(tools):
        rule = f"call{index}"
        opening = f"{SPECIAL_OPEN} {_literal(chr(10) + '<function=' + tool['name'] + '>')}"
        if tool.get("strict") is not True:
            rules.append(f"{rule}: {opening} FREE {SPECIAL_CLOSE}")
        else:
            schema = tool["parameters"]
            properties = schema.get("properties") or {}
            required = set(schema.get("required") or [])
            parts = []
            for position, (name, child) in enumerate(properties.items()):
                part = _parameter(f"{rule}_p{position}", name, child, rules)
                parts.append(part if name in required else f"{part}?")
            body = " ".join(parts)
            rules.append(
                f"{rule}: {opening} {_literal(chr(10))} {body} "
                f"{_literal('</function>' + chr(10))} {SPECIAL_CLOSE}"
            )
        calls.append(rule)
    top = ["start: WS? answer"]
    if calls:
        top.append(f"call: {' | '.join(calls)}")
        top.append("calls: call (WS? call)* WS? <|im_end|>")
    if fmt is not None:
        top.append(f"json_answer: {_json(fmt['schema'])} WS? <|im_end|>")
        top.append("answer: json_answer" + (" | calls" if calls else ""))
    else:
        top.append("answer: TEXT? (calls | <|im_end|>)")
    lexemes = [
        "WS: /[ \\t\\n]{1,8}/",
        "TEXT: /(.|\\n)+/",
        "FREE: /(.|\\n)*/",
    ]
    return "\n".join(top + rules + lexemes) + "\n"


class Structured:
    """The llguidance tokenizer for the served model, built once per worker (~1 s)."""

    def __init__(self, model_dir, vocab_rows: int):
        import llguidance.hf
        from transformers import AutoTokenizer

        tokenizer = AutoTokenizer.from_pretrained(str(model_dir))
        self.tokenizer = llguidance.hf.from_tokenizer(tokenizer)
        self.vocab_rows = vocab_rows

    def constraint(self, request: dict) -> Constraint | None:
        text = grammar(request)
        return Constraint(self, text) if text is not None else None


class Constraint:
    """One request's matcher: the additive logit mask before each constrained token."""

    def __init__(self, owner: Structured, text: str):
        import llguidance
        import llguidance.numpy

        self.matcher = llguidance.LLMatcher(
            owner.tokenizer, llguidance.grammar_from("lark", text), log_level=0
        )
        error = self.matcher.get_error()
        if error:
            raise ValueError(f"structured output grammar: {error}")
        self._fill = llguidance.numpy.fill_next_token_bitmask
        self.size = owner.tokenizer.vocab_size
        self.bitmask = llguidance.numpy.allocate_token_bitmask(1, self.size)
        self.rows = owner.vocab_rows

    def bias(self) -> mx.array:
        """0 for allowed next tokens, -inf for the rest (and for padded vocab rows)."""
        self._fill(self.matcher, self.bitmask, 0)
        bits = np.unpackbits(self.bitmask.view(np.uint8), bitorder="little")[: self.size]
        bias = np.full(self.rows, -np.inf, dtype=np.float32)
        bias[: self.size][bits.astype(bool)] = 0.0
        return mx.array(bias)

    def consume(self, token: int) -> bool:
        return bool(self.matcher.consume_token(token))
