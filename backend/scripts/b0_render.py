"""B0-6/B0-7 (static part): the incremental rendering contract of the official chat template.

Tokenizer only, no model weights. Renders a synthetic agent conversation with the official
template and checks, at every item boundary:
  prefix   render(msgs[:k]) is a string prefix of render(msgs[:k+1])
  tokens   tokenize(render(msgs[:k])) is a token prefix of tokenize(render(msgs[:k+1]))
  genpt    render(msgs[:k], add_generation_prompt) + model output + <|im_end|> reproduces
           render(msgs[:k+1]) (the live-cursor path versus the re-render path)
plus where the effort switches land, what preserve_thinking=false does, and how tool
arguments are serialised. The generated-token side of B0-7 needs the model (b0_bench.py).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from b0_lib import RESULTS, emit  # noqa: E402

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "exec_command",
            "description": "Run a shell command.",
            "parameters": {
                "type": "object",
                "properties": {"cmd": {"type": "string"}},
                "required": ["cmd"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a file.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}, "limit": {"type": "integer"}},
                "required": ["path"],
            },
        },
    },
]


def call(name: str, arguments: dict) -> dict:
    return {"type": "function", "function": {"name": name, "arguments": arguments}}


CONVERSATION = [
    {"role": "system", "content": "You are a coding agent working in a repository."},
    {"role": "user", "content": "List the files."},
    {
        "role": "assistant",
        "reasoning_content": "I should list them.",
        "content": "",
        "tool_calls": [call("exec_command", {"cmd": "ls"})],
    },
    {"role": "tool", "content": "a.txt\nb.txt"},
    {
        "role": "assistant",
        "reasoning_content": "Two files; read both.",
        "content": "Reading both files.",
        "tool_calls": [
            call("read_file", {"path": "a.txt"}),
            call("read_file", {"path": "b.txt", "limit": 20}),
        ],
    },
    {"role": "tool", "content": "alpha"},
    {"role": "tool", "content": "beta"},
    {
        "role": "assistant",
        "reasoning_content": "Done.",
        "content": "a.txt has alpha; b.txt has beta.",
    },
    {"role": "user", "content": "Summarize as JSON."},
    {"role": "assistant", "reasoning_content": "", "content": '{"a": "alpha", "b": "beta"}'},
]


def model_output(message: dict, thinking: bool = True) -> str:
    """The text a model emits after the generation prompt for this assistant message."""
    text = (message.get("reasoning_content", "").strip() + "\n</think>\n\n") if thinking else ""
    content = message.get("content", "").strip()
    text += content
    for index, tool_call in enumerate(message.get("tool_calls", [])):
        function = tool_call["function"]
        text += ("\n\n" if content else "") if index == 0 else "\n"
        text += f"<tool_call>\n<function={function['name']}>\n"
        for key, value in function["arguments"].items():
            rendered = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
            text += f"<parameter={key}>\n{rendered}\n</parameter>\n"
        text += "</function>\n</tool_call>"
    return text + "<|im_end|>"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model", required=True, help="checkpoint directory with tokenizer files")
    args = parser.parse_args()
    os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
    from transformers import AutoTokenizer

    tok = AutoTokenizer.from_pretrained(args.model)

    def render(messages, **kwargs) -> str:
        return tok.apply_chat_template(messages, tools=TOOLS, tokenize=False, **kwargs)

    def ids(text: str) -> list[int]:
        return tok.encode(text, add_special_tokens=False)

    report: dict = {"boundaries": [], "generation": []}
    full = CONVERSATION
    for k in range(2, len(full)):
        a, b = render(full[:k]), render(full[: k + 1])
        ta, tb = ids(a), ids(b)
        entry = {
            "k": k,
            "next_role": full[k]["role"],
            "string_prefix": b.startswith(a),
            "token_prefix": tb[: len(ta)] == ta,
        }
        if not entry["string_prefix"]:
            split = (
                next(i for i, (x, y) in enumerate(zip(a, b, strict=False)) if x != y)
                if a[: len(b)] != b[: len(a)]
                else min(len(a), len(b))
            )
            entry["diverges"] = {
                "prefix_tail": a[max(0, split - 30) : split + 30],
                "full_at": b[max(0, split - 30) : split + 30],
            }
        report["boundaries"].append(entry)
        if full[k]["role"] == "assistant":
            prompt = render(full[:k], add_generation_prompt=True)
            live = prompt + model_output(full[k])
            tokens_live = ids(prompt) + ids(model_output(full[k]))
            report["generation"].append(
                {
                    "k": k,
                    "string_equal_modulo_newline": live + "\n" == b,
                    "token_equal_when_generated_separately": tokens_live + ids("\n")
                    == ids(live + "\n"),
                    "prompt_tokens_prefix_of_rerender": ids(b)[: len(ids(prompt))] == ids(prompt),
                }
            )

    base = render(full[:2], add_generation_prompt=True)
    effort = {}
    for label, kwargs in {
        "xhigh": {"reasoning_effort": "xhigh"},
        "medium": {"reasoning_effort": "medium"},
        "low": {"reasoning_effort": "low"},
        "none": {"enable_thinking": False},
    }.items():
        text = render(full[:2], add_generation_prompt=True, **kwargs)
        first = next((i for i, (x, y) in enumerate(zip(base, text, strict=False)) if x != y), None)
        effort[label] = {
            "first_difference_vs_default": first,
            "length": len(text),
            "same_as_default": text == base,
        }
    report["effort"] = effort

    history = full[:8]
    before = render(history, preserve_thinking=False)
    after = render([*history, {"role": "user", "content": "next"}], preserve_thinking=False)
    report["preserve_thinking_false_keeps_prefix"] = after.startswith(before)

    trimmed = render(
        [
            full[0],
            full[1],
            {"role": "assistant", "reasoning_content": "  padded  \n", "content": "\n answer \n"},
        ]
    )
    report["trim"] = {
        "reasoning_trimmed": "<think>\npadded\n</think>" in trimmed,
        "content_trimmed": "</think>\n\nanswer<|im_end|>" in trimmed,
    }
    sample = render(
        [
            full[0],
            full[1],
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    call("read_file", {"path": "x", "limit": 5, "opts": {"a": 1, "b": [1, 2]}})
                ],
            },
        ]
    )
    report["tool_argument_rendering"] = sample[
        sample.rindex("<tool_call>") : sample.rindex("</tool_call>") + 12
    ]

    RESULTS.mkdir(parents=True, exist_ok=True)
    out = RESULTS / "render_contract.json"
    out.write_text(json.dumps(report, indent=1, ensure_ascii=False))
    for entry in report["boundaries"]:
        tag = "READY" if entry["string_prefix"] and entry["token_prefix"] else "MANUAL"
        emit(
            tag,
            f"boundary k={entry['k']} (next: {entry['next_role']}): "
            f"string_prefix={entry['string_prefix']} token_prefix={entry['token_prefix']}",
        )
    for entry in report["generation"]:
        emit(
            "INFO",
            f"generation k={entry['k']}: "
            + json.dumps({k: v for k, v in entry.items() if k != "k"}),
        )
    emit("INFO", f"effort: {json.dumps(effort)}")
    emit(
        "INFO",
        f"preserve_thinking=false keeps prefix: {report['preserve_thinking_false_keeps_prefix']}",
    )
    emit("INFO", f"trim: {report['trim']}")
    emit("INFO", f"tool arguments render as: {report['tool_argument_rendering']!r}")
    emit("INFO", f"Report: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
