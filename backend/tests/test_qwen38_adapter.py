"""Qwen3.8 adapter: rendering equals the official template; the parser rebuilds items."""

from __future__ import annotations

import json
import os

import pytest
from assets import MODEL_DIR, requires_tokenizer

from aporisa_backend.configs.models import PROFILES, active_pointer, public_model

pytestmark = requires_tokenizer

ALIAS, IDENTITY = active_pointer()
MODEL = public_model(ALIAS, PROFILES[IDENTITY])

TOOLS = [
    {
        "type": "function",
        "name": "exec_command",
        "description": "Run a shell command.",
        "parameters": {
            "type": "object",
            "properties": {"cmd": {"type": "string"}, "timeout": {"type": "integer"}},
            "required": ["cmd"],
        },
        "strict": False,
    },
    {
        "type": "function",
        "name": "edit",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "opts": {"type": "object", "properties": {}},
                "lines": {"type": "array", "items": {"type": "integer"}},
                "force": {"type": "boolean"},
                "note": {"anyOf": [{"type": "null"}, {"type": "string"}]},
                "ratio": {"type": "number"},
            },
        },
    },
]


@pytest.fixture(scope="module")
def codec():
    from aporisa_backend.engine.tokens import Codec

    return Codec(MODEL_DIR)


@pytest.fixture(scope="module")
def adapter(codec):
    from aporisa_backend.engine.adapters.qwen38 import Qwen38Adapter

    return Qwen38Adapter(codec, MODEL)


@pytest.fixture(scope="module")
def official():
    os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
    from transformers import AutoTokenizer

    return AutoTokenizer.from_pretrained(str(MODEL_DIR))


def user(text):
    return {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}


def said(text, phase=None):
    item = {
        "type": "message",
        "role": "assistant",
        "content": [{"type": "output_text", "text": text}],
    }
    if phase:
        item["phase"] = phase
    return item


def thought(text):
    return {
        "type": "reasoning",
        "summary": [],
        "content": [{"type": "reasoning_text", "text": text}],
        "encrypted_content": None,
    }


def call(call_id, name, arguments):
    return {
        "type": "function_call",
        "call_id": call_id,
        "name": name,
        "arguments": json.dumps(arguments, ensure_ascii=False),
    }


def output(call_id, text):
    return {"type": "function_call_output", "call_id": call_id, "output": text}


def to_messages(request):
    """The same conversation in the template's own message format."""
    messages = []
    if request.get("instructions"):
        messages.append({"role": "system", "content": request["instructions"]})
    turn = None
    for item in request["input"]:
        kind = item["type"]
        if kind in ("reasoning", "function_call") or (
            kind == "message" and item["role"] == "assistant"
        ):
            if turn is None:
                turn = {"role": "assistant", "reasoning_content": "", "content": ""}
                messages.append(turn)
            if kind == "reasoning":
                turn["reasoning_content"] += item["content"][0]["text"]
            elif kind == "message":
                turn["content"] += item["content"][0]["text"]
            else:
                turn.setdefault("tool_calls", []).append(
                    {
                        "type": "function",
                        "function": {
                            "name": item["name"],
                            "arguments": json.loads(item["arguments"]),
                        },
                    }
                )
            continue
        turn = None
        if kind == "message":
            messages.append({"role": "user", "content": item["content"][0]["text"]})
        elif kind == "function_call_output":
            messages.append({"role": "tool", "content": item["output"]})
    return messages


def template_kwargs(effort):
    return {
        "high": {"reasoning_effort": "xhigh"},
        "medium": {"reasoning_effort": "medium"},
        "low": {"reasoning_effort": "low"},
        "none": {"enable_thinking": False},
    }[effort]


def official_text(official, request, effort):
    tools = [
        {
            "type": "function",
            "function": {k: t[k] for k in ("name", "description", "parameters") if k in t},
        }
        for t in request.get("tools", [])
    ]
    return official.apply_chat_template(
        to_messages(request),
        tools=tools or None,
        tokenize=False,
        add_generation_prompt=True,
        **template_kwargs(effort),
    )


AGENT_INPUT = [
    user("  List the files and read both.  "),
    thought("I should list them."),
    call("c1", "exec_command", {"cmd": "ls -la"}),
    output("c1", "a.txt\nb.txt\n"),
    thought("Two files; read both."),
    said("Reading both files.", "commentary"),
    call("c2", "edit", {"path": "a.txt", "opts": {"a": 1, "b": [1, 2]}, "lines": [1, 2]}),
    call("c3", "edit", {"path": "b.txt", "force": True, "note": None, "ratio": 0.5}),
    output("c2", "alpha"),
    output("c3", "  beta  "),
    said("a.txt has alpha; b.txt has beta — 完成 🙂", "final_answer"),
    user("Summarize as JSON."),
    said('{"a": "alpha"}'),
    user("Again, no reasoning this time."),
]


CASES = {
    "plain": ({"input": [user("hi")]}, "medium"),
    "instructions": ({"instructions": "  Be terse.\n", "input": [user("hi")]}, "medium"),
    "tools_agent": (
        {"instructions": "You are a coding agent.", "tools": TOOLS, "input": AGENT_INPUT},
        "medium",
    ),
}
for effort in ("high", "low", "none"):
    CASES[f"agent_{effort}"] = (
        {
            "instructions": "You are a coding agent.",
            "tools": TOOLS,
            "input": AGENT_INPUT,
            "reasoning": {"effort": effort},
        },
        effort,
    )
    CASES[f"plain_{effort}"] = ({"input": [user("hi")], "reasoning": {"effort": effort}}, effort)
    CASES[f"instructions_{effort}"] = (
        {"instructions": "Be terse.", "input": [user("hi")], "reasoning": {"effort": effort}},
        effort,
    )


@pytest.mark.parametrize("name", sorted(CASES))
def test_render_equals_official_template(name, adapter, official):
    request, effort = CASES[name]
    request = {"model": ALIAS, **request}
    plan = adapter.render(request)
    text = official_text(official, request, effort)
    assert adapter.codec.decode(plan.tokens) == text
    assert plan.tokens == official.encode(text, add_special_tokens=False)
    assert plan.effort == effort
    assert plan.thinking == (effort != "none")
    assert plan.boundaries == sorted(plan.boundaries)
    assert plan.boundaries[-1] == plan.prompt_start


def test_codec_matches_autotokenizer(codec, official):
    text = official_text(official, {"model": ALIAS, "tools": TOOLS, "input": AGENT_INPUT}, "high")
    assert codec.encode(text) == official.encode(text, add_special_tokens=False)


def test_mid_history_segments_are_spliced_at_boundaries(adapter):
    from aporisa_backend.engine.adapters.qwen38 import UPDATE_TEXT, system_segment

    base = {"model": ALIAS, "tools": TOOLS, "input": AGENT_INPUT[:4]}
    plain = adapter.render(base)
    developer = {
        "type": "message",
        "role": "developer",
        "content": [{"type": "input_text", "text": " Use the repo tools. "}],
    }
    update = {"type": "configuration_update", "reasoning": {"effort": "none"}}
    spliced = adapter.render({**base, "input": [*base["input"], developer, update]})
    cut = plain.prompt_start
    expected = (
        plain.tokens[:cut]
        + adapter.codec.encode(system_segment("Use the repo tools."))
        + adapter.codec.encode(system_segment(UPDATE_TEXT["none"]))
    )
    assert spliced.tokens[: spliced.prompt_start] == expected
    assert spliced.effort == "none" and not spliced.thinking
    assert adapter.codec.decode(spliced.generation_prompt).endswith("<think>\n\n</think>\n\n")


def test_token_map_reuses_generated_ids(adapter):
    from aporisa_backend.engine.adapters.qwen38 import TokenMap, assistant_turn

    token_map = TokenMap()
    turn = [thought(""), said("Done.", "final_answer")]
    request = {"model": ALIAS, "input": [user("x"), *turn, user("y")]}
    text = assistant_turn(turn)
    live = adapter.codec.encode("<|im_start|>assistant\n<think>\n") + adapter.codec.encode(
        "\n</think>\n\nDone.<|im_end|>"
    )
    # Empty reasoning: generated "\n" "\n" versus the re-rendered "\n\n" token (B0-7).
    assert adapter.codec.encode(text) != live
    token_map.put(text, live)
    mapped = adapter.render(request, token_map)
    start = mapped.tokens.index(248045, 1)  # the assistant turn's <|im_start|>
    assert mapped.tokens[start : start + len(live)] == live


def test_tool_choice_none_and_parallel_flags(adapter):
    plan = adapter.render({"model": ALIAS, "input": [user("x")], "tool_choice": "none"})
    assert plan.banned_ids == (248058,)
    assert plan.stop_after_call
    plan = adapter.render({"model": ALIAS, "input": [user("x")], "parallel_tool_calls": True})
    assert plan.banned_ids == () and not plan.stop_after_call


# --- parser ------------------------------------------------------------------------------------


def run_parser(adapter, request, completion: str):
    """Feeds the completion token by token, like the decode loop; returns (events, parser)."""
    from aporisa_backend.engine.adapters.qwen38 import CALL_CLOSE, STOP_IDS

    plan = adapter.render({"model": ALIAS, **request})
    parser = adapter.parser(plan)
    events = []
    for token in adapter.codec.encode(completion):
        if token in STOP_IDS:
            events += parser.finish()
            break
        events += parser.feed(token)
        if parser.failed:
            break
        if plan.stop_after_call and token == CALL_CLOSE:
            events += parser.finish()
            break
    return events, parser


def check_stream(events, parser):
    """Deltas add up to each item; items never interleave."""
    current, text, items = None, "", []
    for event in events:
        if event["type"] == "item_added":
            assert current is None
            current, text = event, ""
        elif event["type"] == "delta":
            assert current is not None
            text += event["text"]
        else:
            item = event["item"]
            final = (
                item["arguments"] if item["type"] == "function_call" else item["content"][0]["text"]
            )
            assert final == text
            items.append(item)
            current = None
    assert current is None or parser.failed
    assert items == parser.items
    return items


def test_parser_reasoning_answer_and_phase(adapter):
    events, parser = run_parser(
        adapter,
        {"input": [user("x")]},
        "  Let me think.  \n\n</think>\n\n  Hello 🙂 world.  \n<|im_end|>",
    )
    items = check_stream(events, parser)
    assert items == [
        {"type": "reasoning", "content": [{"type": "reasoning_text", "text": "Let me think."}]},
        {
            "type": "message",
            "content": [{"type": "output_text", "text": "Hello 🙂 world."}],
            "phase": "final_answer",
        },
    ]


def test_parser_empty_reasoning_emits_no_item(adapter):
    events, parser = run_parser(adapter, {"input": [user("x")]}, "\n</think>\n\nOK<|im_end|>")
    assert [i["type"] for i in check_stream(events, parser)] == ["message"]


def test_parser_none_mode_starts_in_answer(adapter):
    events, parser = run_parser(
        adapter, {"input": [user("x")], "reasoning": {"effort": "none"}}, "Direct.<|im_end|>"
    )
    assert check_stream(events, parser)[0]["content"][0]["text"] == "Direct."
    assert parser.reasoning_tokens == 0


def test_parser_parallel_calls_with_schema_conversion(adapter):
    completion = (
        "plan\n</think>\n\nRunning.\n\n<tool_call>\n<function=exec_command>\n<parameter=cmd>\n"
        "ls -la\n  indented\n</parameter>\n<parameter=timeout>\n30\n</parameter>\n</function>\n"
        '</tool_call>\n<tool_call>\n<function=edit>\n<parameter=opts>\n{"a": [1, 2]}\n'
        "</parameter>\n<parameter=force>\ntrue\n</parameter>\n<parameter=note>\nnull\n"
        "</parameter>\n<parameter=ratio>\nabc\n</parameter>\n<parameter=extra>\n7\n"
        "</parameter>\n</function>\n</tool_call><|im_end|>"
    )
    events, parser = run_parser(
        adapter, {"input": [user("x")], "tools": TOOLS, "parallel_tool_calls": True}, completion
    )
    items = check_stream(events, parser)
    assert [i["type"] for i in items] == ["reasoning", "message", "function_call", "function_call"]
    assert items[1]["phase"] == "commentary"
    assert json.loads(items[2]["arguments"]) == {"cmd": "ls -la\n  indented", "timeout": 30}
    assert json.loads(items[3]["arguments"]) == {
        "opts": {"a": [1, 2]},
        "force": True,
        "note": None,
        "ratio": "abc",
        "extra": "7",
    }


def test_parser_stops_after_first_call_without_parallel(adapter):
    completion = (
        "\n</think>\n\n<tool_call>\n<function=exec_command>\n<parameter=cmd>\nls\n</parameter>\n"
        "</function>\n</tool_call>\n<tool_call>\n<function=exec_command>\n"
    )
    events, parser = run_parser(adapter, {"input": [user("x")], "tools": TOOLS}, completion)
    items = check_stream(events, parser)
    assert [i["name"] for i in items] == ["exec_command"]
    assert items[0]["arguments"] == '{"cmd": "ls"}'


def test_parser_zero_argument_call_and_trailing_text(adapter):
    completion = (
        "\n</think>\n\n<tool_call>\n<function=status>\n</function>\n</tool_call>\nAfter.<|im_end|>"
    )
    events, parser = run_parser(
        adapter, {"input": [user("x")], "parallel_tool_calls": True}, completion
    )
    items = check_stream(events, parser)
    assert items[0] == {"type": "function_call", "name": "status", "arguments": "{}"}
    assert items[1]["content"][0]["text"] == "After." and items[1]["phase"] == "final_answer"


@pytest.mark.parametrize(
    ("completion", "detail"),
    [
        (
            "\n</think>\n\n<tool_call>\n<function=exec_command>\n<parameter=cmd>\nls<|im_end|>",
            "unclosed",
        ),
        ("\n</think>\n\n<tool_call>\nexec_command(ls)\n</tool_call><|im_end|>", "no_function"),
        ("\n</think>\n\n<tool_call>\n</tool_call><|im_end|>", "no_function"),
        ("\n</think>\n\n<tool_call>\n<function=bad name>\n</function>\n</tool_call>", "bad_name"),
        (
            "\n</think>\n\n<tool_call>\n<function=f>\n<parameter=a>\n1\n</parameter>\n"
            "<parameter=a>\n2\n</parameter>\n</function>\n</tool_call>",
            "malformed",
        ),
    ],
)
def test_parser_broken_calls(adapter, completion, detail):
    _, parser = run_parser(adapter, {"input": [user("x")], "tools": TOOLS}, completion)
    assert parser.failed == detail


def test_parsed_items_render_back_to_the_generated_text(adapter):
    """The parser's items re-render (as history) to the text the model generated."""
    from aporisa_backend.engine.adapters.qwen38 import assistant_turn

    completion = (
        "plan\n</think>\n\nRunning.\n\n<tool_call>\n<function=exec_command>\n<parameter=cmd>\n"
        "ls\n</parameter>\n<parameter=timeout>\n30\n</parameter>\n</function>\n</tool_call>"
        "<|im_end|>"
    )
    events, parser = run_parser(
        adapter, {"input": [user("x")], "tools": TOOLS, "parallel_tool_calls": True}, completion
    )
    check_stream(events, parser)
    assert assistant_turn(parser.items) == "<|im_start|>assistant\n<think>\n" + completion
