"""Structured output (B2-4, docs/protocol.md 8.4): grammar, final check, constrained decoding.

The tiny model is random: under the grammar its answer must still be valid. Scripted
samplers stand in for a model that tries to write something specific; where the grammar
forbids a scripted token they fall back to the best allowed one.
"""

from __future__ import annotations

import json

import mlx.core as mx
import pytest
from assets import requires_tokenizer
from conftest import ALIAS, patch_sampler, request, worker_init

from aporisa_backend.engine import generate as gen
from aporisa_backend.engine.adapters.qwen38 import THINK_CLOSE
from aporisa_backend.engine.speculative import MtpDrafter
from aporisa_backend.engine.structured import Constraint, grammar
from aporisa_backend.protocol.structured import closed, instance, value_violation

CITY = {
    "type": "object",
    "properties": {
        "city": {"type": "string"},
        "days": {"type": "integer"},
        "unit": {"type": "string", "enum": ["c", "f"]},
        "tags": {"type": "array", "items": {"type": "string"}},
        "note": {"anyOf": [{"type": "string"}, {"type": "null"}]},
    },
    "required": ["city", "days"],
}
SMALL = {
    "type": "object",
    "properties": {"ok": {"type": "boolean"}, "size": {"type": "string", "enum": ["s", "m"]}},
    "required": ["ok", "size"],
}
TOOLS = [
    {"type": "function", "name": "weather", "parameters": CITY, "strict": True},
    {"type": "function", "name": "free_tool", "parameters": {"type": "object"}},
]


def text_format(schema):
    return {"format": {"type": "json_schema", "name": "x", "schema": schema, "strict": True}}


# --- values ----------------------------------------------------------------------------------


def test_values_follow_the_closed_reading():
    assert value_violation({"city": "x", "days": 2, "note": None}, CITY) is None
    assert value_violation({"city": "x"}, CITY) == "$: missing 'days'"
    assert value_violation({"city": "x", "days": 1.5}, CITY) == "$.days: expected an integer"
    assert value_violation({"city": "x", "days": True}, CITY) == "$.days: expected an integer"
    assert value_violation({"city": "x", "days": 1, "unit": "k"}, CITY).startswith("$.unit")
    assert value_violation({"city": "x", "days": 1, "other": 0}, CITY).endswith("'other'")
    assert value_violation({"a": 1}, {"type": "object", "additionalProperties": True}) is None
    assert value_violation(instance(CITY), CITY) is None
    assert closed(CITY)["additionalProperties"] is False
    assert closed({"type": "object", "additionalProperties": True})["additionalProperties"]


# --- grammar (tokenizer only) ----------------------------------------------------------------


@pytest.fixture(scope="module")
def llg():
    import llguidance
    import llguidance.hf
    from assets import MODEL_DIR
    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(str(MODEL_DIR))
    return tokenizer, llguidance.hf.from_tokenizer(tokenizer)


def accepts(llg, body: dict, text: str) -> bool:
    import llguidance

    tokenizer, lltokenizer = llg
    matcher = llguidance.LLMatcher(
        lltokenizer, llguidance.grammar_from("lark", grammar({"input": [], **body})), log_level=0
    )
    assert not matcher.get_error()
    return all(matcher.consume_token(t) for t in tokenizer.encode(text, add_special_tokens=False))


CALL = (
    "\n\n<tool_call>\n<function=weather>\n<parameter=city>\nNew\nYork\n</parameter>\n"
    "<parameter=days>\n3\n</parameter>\n<parameter=unit>\nc\n</parameter>\n"
    "<parameter=note>\nnull\n</parameter>\n</function>\n</tool_call><|im_end|>"
)


@requires_tokenizer
def test_grammar_accepts_valid_answers(llg):
    fmt = {"text": text_format(CITY)}
    assert accepts(llg, fmt, '\n\n{"city": "Paris", "days": 3, "tags": ["a"]}<|im_end|>')
    assert accepts(llg, {**fmt, "tools": TOOLS}, CALL)
    assert accepts(llg, {"tools": TOOLS}, "Checking the weather." + CALL)
    assert accepts(llg, {"tools": TOOLS}, "It is sunny.<|im_end|>")
    free = "<tool_call>\n<function=free_tool>\n<parameter=x>\nany\n</parameter>\n</function>\n"
    assert accepts(llg, {"tools": TOOLS}, free + "</tool_call><|im_end|>")
    assert grammar({"input": [], "tools": TOOLS, "tool_choice": "none"}) is None
    assert grammar({"input": [], "tools": [TOOLS[1]]}) is None


@requires_tokenizer
def test_grammar_rejects_what_breaks_the_schema(llg):
    fmt = {"text": text_format(CITY)}
    assert not accepts(llg, fmt, '{"city": "Paris", "days": 3, "x": 1}')  # closed object
    assert not accepts(llg, fmt, '{"city": "Paris"}<|im_end|>')  # required
    assert not accepts(llg, fmt, "Sure, here it is")  # no prose with text.format
    assert not accepts(llg, {**fmt, "tools": TOOLS}, "Let me call.<tool_call>")  # no commentary
    head = "<tool_call>\n<function=weather>\n<parameter="
    assert not accepts(llg, {"tools": TOOLS}, "<tool_call>\n<function=nope>")
    assert not accepts(llg, {"tools": TOOLS}, head + "days>\n3")  # schema order
    assert not accepts(llg, {"tools": TOOLS}, head + "city>\nX\n</parameter>\n<parameter=days>\nx")
    tail = "city>\nX\n</parameter>\n<parameter=days>\n3\n</parameter>\n<parameter=unit>\nk"
    assert not accepts(llg, {"tools": TOOLS}, head + tail)  # enum


# --- constrained decoding on the tiny model --------------------------------------------------


@pytest.fixture(scope="module")
def engine(tiny_model_dir, tiny_draft_dir):
    from aporisa_backend.engine import runtime

    engine = runtime.load(
        worker_init(tiny_model_dir, draft_dir=str(tiny_draft_dir), draft_schedule=[[0, 2]])
    )
    assert engine.structured is not None
    runtime.warmup(engine, ALIAS)  # includes a constrained answer
    return engine


def run(engine, body: dict, seed: int = 3) -> tuple[list[dict], dict]:
    mx.random.seed(seed)
    messages: list[dict] = []
    engine.generate({"id": "s", "request": body, "session": None}, messages.append, gen.JobFlags())
    return messages, dict(engine.metrics)


def items(messages):
    return [m["item"] for m in messages if m["type"] == "item_done"]


def answer(messages):
    message = next(i for i in items(messages) if i["type"] == "message")
    return json.loads(message["content"][0]["text"])


def test_a_random_model_answers_with_schema_json(engine):
    body = request("anything", max_output_tokens=200, reasoning={"effort": "none"})
    messages, _ = run(engine, {**body, "text": text_format(SMALL)})
    assert messages[-1]["type"] == "finished" and messages[-1]["status"] == "completed"
    [message] = [i for i in items(messages) if i["type"] == "message"]
    assert message["phase"] == "final_answer"
    assert value_violation(answer(messages), SMALL) is None


@pytest.fixture
def scripted(monkeypatch, engine):
    """script(text): sample these tokens in order while allowed; under a grammar a token
    it forbids is replaced by the best allowed one (as a model would be steered)."""
    record: list[tuple[int, bool]] = []

    def use(text: str):
        tokens = engine.adapter.codec.encode(text)
        state = {"index": 0}

        def sample(self, logits, bias=None):
            wanted = tokens[min(state["index"], len(tokens) - 1)]
            state["index"] += 1
            if bias is not None and not bool(bias[wanted] == 0):
                wanted = int(mx.argmax(logits.astype(mx.float32) + self.mask + bias).item())
            record.append((wanted, bias is not None))
            return wanted

        patch_sampler(monkeypatch, sample)
        return tokens

    use.record = record
    return use


def test_reasoning_is_free_and_the_answer_constrained(engine, scripted, monkeypatch):
    reply = 'Thinking about it.\n</think>\n\n{"ok": true, "size": "m"}<|im_end|>'
    tokens = scripted(reply)
    # MTP drafts the script itself: a round may verify </think> and answer tokens together.
    real = MtpDrafter.propose

    def propose(self, state, bonus, count):
        drafts = real(self, state, bonus, count)
        position = len(scripted.record)
        return [tokens[min(position + i, len(tokens) - 1)] for i in range(len(drafts))]

    monkeypatch.setattr(MtpDrafter, "propose", propose)
    body = request("hi", max_output_tokens=100, reasoning={"effort": "medium"})
    messages, _ = run(engine, {**body, "text": text_format(SMALL)})
    assert messages[-1]["status"] == "completed"
    assert [i["type"] for i in items(messages)] == ["reasoning", "message"]
    assert answer(messages) == {"ok": True, "size": "m"}
    record = scripted.record
    close = next(k for k, (token, _) in enumerate(record) if token == THINK_CLOSE)
    assert not any(masked for _, masked in record[: close + 1])  # reasoning: never masked
    assert all(masked for _, masked in record[close + 1 :])  # answer: always masked


def test_a_strict_call_is_steered_into_its_schema(engine, scripted):
    bad = CALL.replace("<parameter=days>\n3", "<parameter=days>\nthree")
    scripted(bad)
    body = request("weather?", max_output_tokens=120, reasoning={"effort": "none"})
    messages, _ = run(engine, {**body, "tools": TOOLS})
    calls = [i for i in items(messages) if i["type"] == "function_call"]
    assert messages[-1]["type"] == "finished"
    if messages[-1]["status"] == "completed":
        assert calls and calls[0]["name"] == "weather"
    for call in calls:
        assert value_violation(json.loads(call["arguments"]), CITY) is None


def test_the_final_check_fails_what_the_grammar_let_through(engine, scripted, monkeypatch):
    # Without the mask (a grammar bug stand-in) the invalid argument reaches the final check.
    monkeypatch.setattr(Constraint, "bias", lambda self: None)
    monkeypatch.setattr(Constraint, "consume", lambda self, token: True)
    scripted(CALL.replace("<parameter=days>\n3", "<parameter=days>\nthree"))
    body = request("weather?", max_output_tokens=120, reasoning={"effort": "none"})
    messages, _ = run(engine, {**body, "tools": TOOLS})
    assert messages[-1] == {"id": "s", "type": "failed", "code": "structured_output_invalid"}
    assert not [i for i in items(messages) if i["type"] == "function_call"]


def test_the_format_is_told_to_the_model_after_the_history(engine):
    body = request("hi", reasoning={"effort": "none"})
    plain = engine.adapter.render(body)
    shaped = engine.adapter.render({**body, "text": text_format(SMALL)})
    # the history's prefix is unchanged; the schema segment sits right before the prompt
    assert shaped.tokens[: plain.prompt_start] == plain.tokens[: plain.prompt_start]
    segment = engine.adapter.codec.decode(shaped.tokens[plain.prompt_start : shaped.prompt_start])
    assert '"size"' in segment and segment.startswith("<|im_start|>system")
