"""Qwen3.8 adapter: rendering equals the official template; the parser rebuilds items."""

from __future__ import annotations

import json
import os

import pytest
from assets import MODEL_DIR, requires_tokenizer

from aporisa_backend.configs.models import PROFILES, active_pointer, public_model
from aporisa_backend.engine.vision import VISION_IDS

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
    vision = tuple(sorted(VISION_IDS))  # input-only tokens are never sampled
    plan = adapter.render({"model": ALIAS, "input": [user("x")], "tool_choice": "none"})
    assert plan.banned_ids == (248058, *vision)
    assert plan.stop_after_call
    plan = adapter.render({"model": ALIAS, "input": [user("x")], "parallel_tool_calls": True})
    assert plan.banned_ids == vision and not plan.stop_after_call


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


# --- images (B2-6) ---------------------------------------------------------------------------


def image_url(width, height, color=(200, 40, 40), kind="PNG", orientation=None):
    import base64
    import io

    from PIL import Image

    image = Image.new("RGB", (width, height), color)
    image.paste((255, 255, 255), (0, 0, max(1, width // 4), height))
    buffer = io.BytesIO()
    options = {}
    if orientation is not None:
        exif = Image.Exif()
        exif[0x0112] = orientation
        options["exif"] = exif.tobytes()
    image.save(buffer, format=kind, **options)
    return f"data:image/{kind.lower()};base64," + base64.b64encode(buffer.getvalue()).decode()


def picture(url, detail=None):
    part = {"type": "input_image", "image_url": url}
    return {**part, "detail": detail} if detail else part


@pytest.fixture(scope="module")
def policy():
    from aporisa_backend.engine.vision import ImagePolicy
    from aporisa_backend.gateway.process_worker import image_policy

    return ImagePolicy.load(MODEL_DIR, image_policy(PROFILES[IDENTITY]))


@pytest.fixture(scope="module")
def seeing(codec, policy):
    from aporisa_backend.engine.adapters.qwen38 import Qwen38Adapter

    return Qwen38Adapter(codec, MODEL, policy)


def test_render_with_images_equals_template_and_processor(seeing, official):
    """The template's placeholders, each pad expanded to the image's tokens (what the model's
    processor does to the template text), tokenized as one string."""
    from aporisa_backend.engine.vision import IMAGE_PAD

    first, second = image_url(640, 480), image_url(300, 900, (10, 90, 200))
    request = {
        "model": ALIAS,
        "tools": TOOLS[:1],
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "  Compare "},
                    picture(first),
                    {"type": "input_text", "text": " with the screenshot. "},
                ],
            },
            call("c1", "exec_command", {"cmd": "screenshot"}),
            {
                "type": "function_call_output",
                "call_id": "c1",
                "output": [{"type": "input_text", "text": "Saved:"}, picture(second, "high")],
            },
        ],
    }
    plan = seeing.render(request)
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "  Compare "},
                {"type": "image"},
                {"type": "text", "text": " with the screenshot. "},
            ],
        },
        {
            "role": "assistant",
            "reasoning_content": "",
            "content": "",
            "tool_calls": [
                {
                    "type": "function",
                    "function": {"name": "exec_command", "arguments": {"cmd": "screenshot"}},
                }
            ],
        },
        {"role": "tool", "content": [{"type": "text", "text": "Saved:"}, {"type": "image"}]},
    ]
    tools = [
        {
            "type": "function",
            "function": {k: TOOLS[0][k] for k in ("name", "description", "parameters")},
        }
    ]
    text = official.apply_chat_template(
        messages, tools=tools, tokenize=False, add_generation_prompt=True, reasoning_effort="medium"
    )
    pads = [spec.tokens for _, spec in plan.images]
    pieces = text.split("<|image_pad|>")
    assert len(pieces) == 3
    expanded = (
        pieces[0] + "<|image_pad|>" * pads[0] + pieces[1] + "<|image_pad|>" * pads[1] + pieces[2]
    )
    assert plan.tokens == official.encode(expanded, add_special_tokens=False)
    for start, spec in plan.images:
        assert plan.tokens[start - 1 : start + spec.tokens + 1] == [
            248053,
            *[IMAGE_PAD] * spec.tokens,
            248054,
        ]
    assert [spec.param for _, spec in plan.images] == ["input[0].content[1]", "input[2].output[1]"]


def test_image_tokens_follow_the_detail_caps(seeing, policy):
    from aporisa_backend.engine.vision import describe

    def tokens(width, height, detail=None):
        return describe(picture(image_url(width, height), detail), "p", policy).tokens

    assert tokens(64, 64) == 64  # scaled up to the model's minimum (256x256)
    assert tokens(512, 512) == 256  # 32x32 pixels per token, already within the cap
    assert tokens(1920, 1080) <= 1024 < tokens(1920, 1080, "high") <= 4096
    assert tokens(4000, 3000, "high") <= 4096
    # the same count as the processor that preprocesses the pixels
    processor = policy.processor("auto")
    assert tokens(1920, 1080) == processor.num_image_tokens(1080, 1920)


def test_keys_tell_images_apart_and_positions_follow_mrope(seeing):
    import numpy as np

    def render(color, detail=None):
        content = [
            {"type": "input_text", "text": "Look:"},
            picture(image_url(320, 256, color), detail),
        ]
        return seeing.render(
            {"model": ALIAS, "input": [{"type": "message", "role": "user", "content": content}]}
        )

    red, blue, red_again = render((200, 40, 40)), render((40, 40, 200)), render((200, 40, 40))
    assert red.tokens == blue.tokens  # pads are pads
    assert red.keys == red_again.keys and red.keys != blue.keys
    [(start, spec)] = red.images
    assert red.keys[start] < 0 and red.keys[start + 1 :] == red.tokens[start + 1 :]
    assert red.keys[:start] == red.tokens[:start]
    # text before the image counts up; the image takes (row, column) positions; text after
    # continues from the image's largest position + 1
    positions = red.positions
    assert (positions[:, :start] == np.arange(start)).all()
    h, w = spec.grid_h, spec.grid_w
    assert (positions[0, start : start + h * w] == start).all()
    assert positions[1, start + w] == start + 1 and positions[2, start + 1] == start + 1
    after = start + h * w
    assert positions[0, after] == start + max(h, w)
    assert red.position_shift == positions[0, -1] + 1 - len(red.tokens)
    assert render((200, 40, 40), "high").keys[start] != red.keys[start]  # detail is identity


def test_exif_orientation_is_applied(policy):
    from aporisa_backend.engine.vision import decode, describe

    spec = describe(picture(image_url(400, 200, kind="JPEG", orientation=6)), "p", policy)
    assert (spec.width, spec.height) == (200, 400)
    assert decode(spec, policy).shape == (3, 400, 200)


def test_unusable_images_name_their_part(adapter, policy):
    import base64

    from aporisa_backend.engine.vision import ImageError, describe

    png = image_url(64, 64)
    data = base64.b64decode(png.split(",", 1)[1])
    cases = [
        "data:image/jpeg;base64," + base64.b64encode(data).decode(),  # declared JPEG, is PNG
        image_url(20_000, 40),  # aspect ratio beyond 200:1
    ]
    for url in cases:
        with pytest.raises(ImageError) as error:
            describe(picture(url), "input[0].content[1]", policy)
        assert error.value.param == "input[0].content[1]"
    from dataclasses import replace

    small = replace(policy, max_source_pixels=1000)
    with pytest.raises(ImageError):
        describe(picture(png), "p", small)
    # an adapter without an image policy (a text-only model) cannot render one
    request = {
        "model": ALIAS,
        "input": [{"type": "message", "role": "user", "content": [picture(png)]}],
    }
    with pytest.raises(ImageError):
        adapter.render(request)
