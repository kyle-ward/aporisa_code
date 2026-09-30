"""B0 measurements on a converted Qwen3.8-Flash-Next checkpoint (DEVELOPMENT_PLAN.md B0).

User-run, long-running, loads the real model. Every subcommand appends JSON lines to
.runtime/b0/results/ (numbers only; `quality` also stores its test transcripts under
.runtime/b0/quality/, which never enter Git).

  curve         B0-4 memory and B0-5 speed: prefill/decode at several contexts and chunk sizes
  snapshot      B0-8 exactness of "truncate KV + restore DeltaNet snapshot" versus cold prefill
  continuation  B0-9 time to first token of an agent loop, live cursor versus cold each step
  mtp           B0-10 decode speed and acceptance with the MTP draft model
  boundary      B0-11 behaviour at the 262,144-token native limit
  quality       B0-12 small agent-task check, effort segments, developer rendering, and the
                generated-token side of B0-7 (re-render versus generated ids)
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mlx.core as mx  # noqa: E402
from b0_lib import (  # noqa: E402
    ROOT,
    Results,
    corpus_tokens,
    emit,
    enable_ple_prefetch,
    gib,
    load_model,
    ple_table,
    prefill,
    restore,
    snapshot,
    snapshot_bytes,
    text_positions,
    tokenizer_of,
)

IM_END, END_OF_TEXT, TOOL_CALL_OPEN = 248046, 248044, 248058
THINKING = {"temperature": 1.0, "top_p": 0.95, "top_k": 20}
NON_THINKING = {"temperature": 0.7, "top_p": 0.8, "top_k": 20, "presence_penalty": 1.5}


def ints(text: str) -> list[int]:
    return [int(v) for v in text.split(",") if v]


def cache_bytes(cache: list) -> int:
    total = 0
    for entry in cache:
        for value in entry.state if isinstance(entry.state, (list, tuple)) else []:
            total += value.nbytes if isinstance(value, mx.array) else 0
    return total


def ple_stats(model) -> dict | None:
    """Row-store counters of the external PLE table (a plain class, not an nn.Module)."""
    table = ple_table(model)
    return dataclasses.asdict(table.stats) if table is not None else None


def load(args):
    model, processor = load_model(args.model)
    if not args.no_ple_prefetch:
        enable_ple_prefetch(model)
    return model, processor


def warmup(lm, tokenizer) -> float:
    """Compiles the prefill and decode kernels on tokens the measurements do not start with."""
    started = time.monotonic()
    tokens = corpus_tokens(tokenizer, 4096)[3072:]
    cache = lm.make_cache()
    logits = prefill(lm, cache, tokens, len(tokens))
    greedy_decode(lm, cache, logits, 4)
    seconds = time.monotonic() - started
    emit("INFO", f"Warm-up done in {seconds:.1f}s (kernel compilation, first PLE reads).")
    return seconds


def greedy_decode(lm, cache: list, first_logits: mx.array, count: int) -> tuple[list[int], float]:
    """Greedy decode of `count` tokens after a prefill; returns (tokens, seconds)."""
    offset = max(int(getattr(c, "offset", 0) or 0) for c in cache)
    y = mx.argmax(first_logits)
    tokens = []
    started = time.monotonic()
    for index in range(count):
        out = lm(
            y.reshape(1, 1),
            cache=cache,
            position_ids=text_positions(offset + index, 1),
            logits_to_keep=1,
        )
        tokens.append(y)
        y = mx.argmax(out.logits[0, -1])
        mx.async_eval(y)
    mx.eval(y)
    seconds = time.monotonic() - started
    return [int(t.item()) for t in tokens], seconds


def progress(total: int, label: str):
    marks = {int(total * f / 10) for f in range(1, 11)}
    started = time.monotonic()

    def report(done: int) -> None:
        if any(done >= m for m in list(marks)):
            for m in [m for m in marks if done >= m]:
                marks.discard(m)
            rate = done / max(time.monotonic() - started, 1e-9)
            emit("INFO", f"{label}: {done}/{total} tokens, {rate:.0f} tok/s")

    return report


# --- curve (B0-4, B0-5) -----------------------------------------------------------------------


def cmd_curve(args) -> None:
    results = Results(f"curve_{Path(args.model).name}")
    model, processor = load(args)
    lm = model.language_model
    weights = mx.get_active_memory()
    results.write({"kind": "weights", "model": args.model, "active_bytes": weights})
    results.write({"kind": "warmup", "seconds": round(warmup(lm, tokenizer_of(processor)), 1)})
    runs = [(n, args.step) for n in ints(args.contexts)]
    runs += [(args.sweep_context, s) for s in ints(args.sweep_steps) if s != args.step]
    tokens = corpus_tokens(tokenizer_of(processor), max(n for n, _ in runs))
    rows = []
    for context, step in runs:
        mx.clear_cache()
        mx.reset_peak_memory()
        cache = lm.make_cache()
        ple_before = ple_stats(model)
        started = time.monotonic()
        logits = prefill(
            lm,
            cache,
            tokens[:context],
            step,
            on_chunk=progress(context, f"prefill {context} step {step}"),
        )
        prefill_s = time.monotonic() - started
        prefill_peak = mx.get_peak_memory()
        _, decode_s = greedy_decode(lm, cache, logits, args.decode)
        ple_after = ple_stats(model)
        row = {
            "kind": "curve",
            "context": context,
            "prefill_step": step,
            "prefill_s": round(prefill_s, 2),
            "prefill_tok_s": round(context / prefill_s, 1),
            "decode_tokens": args.decode,
            "decode_tok_s": round(args.decode / decode_s, 2),
            "peak_prefill_bytes": prefill_peak,
            "peak_total_bytes": mx.get_peak_memory(),
            "active_after_bytes": mx.get_active_memory(),
            "cache_bytes": cache_bytes(cache),
            "weights_bytes": weights,
        }
        if ple_before and ple_after:
            row["ple_bytes_read"] = ple_after["bytes_read"] - ple_before["bytes_read"]
            row["ple_seconds"] = round(
                ple_after["elapsed_seconds"] - ple_before["elapsed_seconds"], 2
            )
            # PLE lookups block the GPU (row ids are evaluated first), so this is the
            # prefill rate once the worker overlaps row reads with compute.
            compute_s = max(prefill_s - row["ple_seconds"], 1e-9)
            row["prefill_compute_tok_s"] = round(context / compute_s, 1)
        results.write(row)
        rows.append(row)
        emit(
            "READY",
            f"ctx {context:>6} step {step:>5}: prefill {row['prefill_tok_s']:>7} tok/s "
            f"(compute {row.get('prefill_compute_tok_s', '-')}), decode "
            f"{row['decode_tok_s']:>5} tok/s, peak {gib(row['peak_total_bytes'])} GiB, "
            f"cache {gib(row['cache_bytes'])} GiB",
        )
        del cache
    emit("INFO", f"Weights resident: {gib(weights)} GiB. Results: {results.path}")


# --- snapshot (B0-8) --------------------------------------------------------------------------


def compare(reference: mx.array, other: mx.array) -> dict:
    p = mx.softmax(reference)
    q = mx.softmax(other)
    kl = mx.sum(p * (mx.log(p + 1e-30) - mx.log(q + 1e-30)))
    top_ref = set(mx.argsort(-reference)[:5].tolist())
    top_other = set(mx.argsort(-other)[:5].tolist())
    return {
        "max_abs": round(mx.abs(reference - other).max().item(), 6),
        "mean_abs": round(mx.abs(reference - other).mean().item(), 6),
        "top1_equal": int(mx.argmax(reference).item()) == int(mx.argmax(other).item()),
        "top5_overlap": len(top_ref & top_other),
        "kl": float(kl.item()),
        "logit_scale": round(mx.abs(reference).max().item(), 3),
    }


def cmd_snapshot(args) -> None:
    results = Results(f"snapshot_{Path(args.model).name}")
    model, processor = load(args)
    lm = model.language_model
    tokenizer = tokenizer_of(processor)
    for length in ints(args.lengths):
        tokens = corpus_tokens(tokenizer, length + 4096)
        n = int(length * args.boundary)
        head, tail, detour = tokens[:n], tokens[n:length], tokens[length : length + 4096]
        step, alt = args.step, args.alt_step

        cache = lm.make_cache()
        prefill(lm, cache, head, step)
        aligned = prefill(lm, cache, tail, step)

        cache = lm.make_cache()
        prefill(lm, cache, head, step)
        started = time.monotonic()
        snap = snapshot(cache)
        snap_s = time.monotonic() - started
        prefill(lm, cache, detour, step)  # history moves on, then the tail gets rewritten
        started = time.monotonic()
        restore(cache, snap)
        restore_s = time.monotonic() - started
        restored = prefill(lm, cache, tail, step)
        # Per-token cost of the growing caches: QSA keys, values, indexer keys and positions.
        kv_per_token = sum(
            sum(v.nbytes for v in entry.state if isinstance(v, mx.array))
            for entry in cache
            if hasattr(entry, "keys")
        ) / max(1, length)

        restore(cache, snap)
        restored_alt = prefill(lm, cache, tail, alt)
        cold_alt = prefill(lm, lm.make_cache(), tokens[:length], alt)

        row = {
            "kind": "snapshot",
            "length": length,
            "boundary": n,
            "step": step,
            "alt_step": alt,
            "restore_vs_aligned_cold": compare(aligned, restored),
            "cold_alt_chunking_vs_cold": compare(aligned, cold_alt),
            "restore_alt_chunking_vs_cold": compare(aligned, restored_alt),
            "snapshot_bytes": snapshot_bytes(snap),
            "kv_bytes_per_token": round(kv_per_token, 1),
            "snapshot_ms": round(snap_s * 1000, 2),
            "restore_ms": round(restore_s * 1000, 2),
        }
        results.write(row)
        exact = row["restore_vs_aligned_cold"]
        noise = row["cold_alt_chunking_vs_cold"]
        emit(
            "READY" if exact["max_abs"] == 0 else "MANUAL",
            f"len {length} boundary {n}: restore vs aligned cold max_abs={exact['max_abs']} "
            f"top1={exact['top1_equal']}; chunking noise max_abs="
            f"{noise['max_abs']} kl={noise['kl']:.2e}; "
            f"snapshot {row['snapshot_bytes'] / 1024**2:.1f} MiB, "
            f"KV {row['kv_bytes_per_token']:.0f} B/token",
        )
    emit("INFO", f"Results: {results.path}")


# --- continuation (B0-9) ----------------------------------------------------------------------


def cmd_continuation(args) -> None:
    results = Results(f"continuation_{Path(args.model).name}")
    model, processor = load(args)
    lm = model.language_model
    tokenizer = tokenizer_of(processor)
    pool = corpus_tokens(tokenizer, args.base + args.steps * args.append + 8192)
    history = pool[: args.base]
    cursor = args.base
    cache = lm.make_cache()
    logits = prefill(lm, cache, history, args.step)
    rows = []
    for index in range(args.steps):
        generated, _ = greedy_decode(lm, cache, logits, args.generate)
        appended = pool[cursor : cursor + args.append]
        cursor += args.append
        # greedy_decode feeds every returned token, so the live cache already holds `generated`;
        # the delta is just the new tool output.
        delta = appended
        history = history + generated + appended
        mx.clear_cache()
        started = time.monotonic()
        logits = prefill(lm, cache, delta, args.step)
        live_s = time.monotonic() - started

        mx.clear_cache()
        cold_cache = lm.make_cache()
        started = time.monotonic()
        prefill(lm, cold_cache, history, args.step)
        cold_s = time.monotonic() - started
        del cold_cache
        row = {
            "kind": "continuation",
            "step": index + 1,
            "history_tokens": len(history),
            "delta_tokens": len(delta),
            "ttft_live_s": round(live_s, 3),
            "ttft_cold_s": round(cold_s, 3),
            "speedup": round(cold_s / live_s, 1),
        }
        rows.append(row)
        results.write(row)
        emit(
            "READY",
            f"step {index + 1}: history {len(history)} tokens; "
            f"live {live_s:.2f}s vs cold {cold_s:.2f}s "
            f"(x{row['speedup']})",
        )
    emit("INFO", f"Results: {results.path}")


# --- chat helpers (mtp, quality) --------------------------------------------------------------

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "exec_command",
            "description": "Run a shell command in the repository and return its output.",
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
            "description": "Read a text file from the repository.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    },
]
EFFORT_TEXT = {
    # xhigh and low are the official template sentences; medium and none have no official text.
    "xhigh": "Reasoning effort is set to xhigh. Please think carefully through the task, "
    "validate key assumptions, consider plausible alternatives, and prioritize correctness, "
    "consistency, and clarity "
    "in the final answer.",
    "low": "Reasoning effort is set to low. Keep your thinking brief and focused, "
    "moving directly to the "
    "conclusion without unnecessary elaboration.",
    "medium": "Reasoning effort is set to medium.",
    "none": "Reasoning is disabled from here on; answer directly.",
}


def generate(
    model,
    tokenizer,
    prompt: str,
    *,
    max_tokens: int,
    params: dict,
    seed: int,
    draft=None,
    block=None,
):
    """Samples one completion; returns (text, token ids, seconds, prompt tokens, stop reason)."""
    from mlx_vlm.generate.ar import generate_step

    lm = model.language_model
    lm._position_ids = None
    lm._rope_deltas = None
    ids = tokenizer.encode(prompt, add_special_tokens=False)
    kwargs = dict(params)
    if draft is not None:
        kwargs.update(draft_model=draft, draft_kind="mtp", draft_block_size=block)
    tokens, reason = [], "length"
    started = time.monotonic()
    for token, _ in generate_step(
        mx.array([ids]),
        model,
        None,
        None,
        max_tokens=max_tokens,
        seed=seed,
        prefill_step_size=2048,
        **kwargs,
    ):
        token = int(token.item() if hasattr(token, "item") else token)
        if token in (IM_END, END_OF_TEXT):
            reason = "stop"
            break
        tokens.append(token)
    seconds = time.monotonic() - started
    return tokenizer.decode(tokens), tokens, seconds, len(ids), reason


def split_output(text: str) -> dict:
    """Splits a thinking-mode completion into reasoning, content and tool calls."""
    # The generation prompt opens <think>: without a closing tag the output was cut off while
    # still reasoning, so all of it is reasoning. Non-thinking callers prefix "</think>".
    reasoning, _, rest = text.partition("</think>") if "</think>" in text else (text, "", "")
    content, _, calls_text = rest.partition("<tool_call>")
    calls = []
    for block in re.findall(r"<tool_call>(.*?)</tool_call>", "<tool_call>" + calls_text, re.S):
        match = re.search(r"<function=([^>\n]+)>(.*?)</function>", block, re.S)
        if not match:
            calls.append({"malformed": block[:200]})
            continue
        arguments = {}
        for name, value in re.findall(
            r"<parameter=([^>\n]+)>\n?(.*?)\n?</parameter>", match.group(2), re.S
        ):
            arguments[name] = value
        calls.append({"name": match.group(1), "arguments": arguments})
    return {"reasoning": reasoning.strip(), "content": content.strip(), "tool_calls": calls}


def user_turn(text: str) -> str:
    return f"<|im_start|>user\n{text}<|im_end|>\n"


def segment(text: str, role: str = "system") -> str:
    return f"<|im_start|>{role}\n{text}<|im_end|>\n"


def gen_prompt(effort: str) -> str:
    return "<|im_start|>assistant\n" + (
        "<think>\n\n</think>\n\n" if effort == "none" else "<think>\n"
    )


# --- mtp (B0-10) ------------------------------------------------------------------------------

MTP_PROMPTS = [
    "Write a Python function that parses an ISO-8601 duration string such as PT1H30M "
    "into seconds, with tests.",
    "Explain, step by step, how a B-tree insertion splits nodes, then give a short "
    "TypeScript implementation.",
    "Refactor this into idiomatic Rust and explain each change:\n\n"
    "fn f(v: Vec<i32>) -> i32 { let mut s = 0; "
    "for i in 0..v.len() { if v[i] % 2 == 0 { s = s + v[i]; } } return s; }",
]


def cmd_mtp(args) -> None:
    from mlx_vlm.speculative.drafters import load_drafter

    results = Results(f"mtp_{Path(args.model).name}")
    model, processor = load(args)
    tokenizer = tokenizer_of(processor)
    draft, kind = load_drafter(args.draft, kind="mtp")
    emit("READY", f"Loaded drafter ({kind}).")
    warm = tokenizer.apply_chat_template(
        [{"role": "user", "content": "Say hello."}], tokenize=False, add_generation_prompt=True
    )
    for draft_model in (None, draft):
        generate(
            model,
            tokenizer,
            warm,
            max_tokens=16,
            params={"temperature": 0.0},
            seed=0,
            draft=draft_model,
            block=1 if draft_model else None,
        )
    emit("INFO", "Warm-up done for plain and speculative decoding.")
    modes = {"greedy": {"temperature": 0.0}, "thinking": THINKING}
    for mode, params in modes.items():
        for index, text in enumerate(MTP_PROMPTS):
            prompt = tokenizer.apply_chat_template(
                [{"role": "user", "content": text}],
                tokenize=False,
                add_generation_prompt=True,
                reasoning_effort="medium",
            )
            for block in [0, *ints(args.block_sizes)]:
                draft_model = draft if block else None
                if draft_model is not None:
                    draft.accept_lens, draft.draft_lens = [], []
                try:
                    _, tokens, seconds, _, _ = generate(
                        model,
                        tokenizer,
                        prompt,
                        max_tokens=args.max_tokens,
                        params=params,
                        seed=index,
                        draft=draft_model,
                        block=block or None,
                    )
                except ValueError as error:
                    emit("MANUAL", f"{mode} block {block}: {error}")
                    results.write(
                        {
                            "kind": "mtp",
                            "mode": mode,
                            "prompt": index,
                            "block": block,
                            "error": str(error),
                        }
                    )
                    continue
                accepted = list(getattr(draft, "accept_lens", []) or []) if block else []
                drafted = list(getattr(draft, "draft_lens", []) or []) if block else []
                row = {
                    "kind": "mtp",
                    "mode": mode,
                    "prompt": index,
                    "block": block,
                    "tokens": len(tokens),
                    "tok_s": round(len(tokens) / seconds, 2),
                    "rounds": len(accepted),
                    "accept_rate": round(sum(accepted) / sum(drafted), 3)
                    if drafted and sum(drafted)
                    else None,
                }
                results.write(row)
                emit(
                    "READY",
                    f"{mode} prompt {index} block {block}: {row['tok_s']} tok/s "
                    f"accept={row['accept_rate']}",
                )
    emit("INFO", f"Results: {results.path}")


# --- boundary (B0-11) -------------------------------------------------------------------------


def cmd_boundary(args) -> None:
    results = Results(f"boundary_{Path(args.model).name}")
    model, processor = load(args)
    lm = model.language_model
    total = args.length
    tokens = corpus_tokens(tokenizer_of(processor), total - args.decode)
    mx.reset_peak_memory()
    cache = lm.make_cache()
    started = time.monotonic()
    logits = prefill(lm, cache, tokens, args.step, on_chunk=progress(len(tokens), "prefill"))
    prefill_s = time.monotonic() - started
    finite = [bool(mx.all(mx.isfinite(logits)).item())]
    offset = len(tokens)
    y = mx.argmax(logits)
    for index in range(args.decode + args.beyond):
        out = lm(
            y.reshape(1, 1),
            cache=cache,
            position_ids=text_positions(offset + index, 1),
            logits_to_keep=1,
        )
        step_logits = out.logits[0, -1].astype(mx.float32)
        finite.append(bool(mx.all(mx.isfinite(step_logits)).item()))
        y = mx.argmax(step_logits)
    last_ok = max((i for i, ok in enumerate(finite) if ok), default=-1)
    row = {
        "kind": "boundary",
        "prompt_tokens": len(tokens),
        "final_position": offset + args.decode + args.beyond - 1,
        "native_limit": total,
        "all_finite_to_limit": all(finite[: args.decode + 1]),
        "all_finite_beyond": all(finite[args.decode + 1 :]),
        "first_non_finite_step": None if all(finite) else finite.index(False),
        "last_finite_step": last_ok,
        "prefill_s": round(prefill_s, 1),
        "prefill_tok_s": round(len(tokens) / prefill_s, 1),
        "peak_bytes": mx.get_peak_memory(),
        "cache_bytes": cache_bytes(cache),
    }
    results.write(row)
    emit("READY" if row["all_finite_to_limit"] else "MANUAL", json.dumps(row))
    emit("INFO", f"Results: {results.path}")


# --- quality (B0-12 and the generated side of B0-7) -------------------------------------------

PUZZLE = (
    "How many positive integers less than 1000 are divisible by 7 but not by 11? "
    "Give the final number."
)
PUZZLE_ANSWER = "130"
SUMMARY_KEYS = ("output_tokens", "tool_calls", "malformed_calls", "stop")


def rerender_check(
    tokenizer, messages: list, prompt: str, generated: list[int], thinking: bool
) -> dict:
    """Does re-rendering the completion as history reproduce the generated token ids?"""
    parsed = split_output(tokenizer.decode(generated))
    message = {"role": "assistant", "content": parsed["content"]}
    if thinking:
        message["reasoning_content"] = parsed["reasoning"]
    if parsed["tool_calls"] and all("name" in c for c in parsed["tool_calls"]):
        message["tool_calls"] = [
            {"type": "function", "function": {"name": c["name"], "arguments": c["arguments"]}}
            for c in parsed["tool_calls"]
        ]
    full = tokenizer.apply_chat_template(
        messages + [message], tools=TOOLS, tokenize=False, reasoning_effort="medium"
    )
    if not full.startswith(prompt.rsplit("<|im_start|>assistant", 1)[0]):
        return {"comparable": False}
    suffix = full[len(prompt) :]
    expected = suffix[: suffix.rfind("<|im_end|>")] if "<|im_end|>" in suffix else suffix
    whole = tokenizer.encode(full, add_special_tokens=False)
    prompt_ids = tokenizer.encode(prompt, add_special_tokens=False)
    segment_ids = tokenizer.encode(expected, add_special_tokens=False)
    first_diff = next(
        (i for i, (a, b) in enumerate(zip(generated, segment_ids, strict=False)) if a != b), None
    )
    return {
        "comparable": True,
        "text_equal": tokenizer.decode(generated) == expected,
        "segmentwise_ids_equal": segment_ids == generated,
        "whole_string_prompt_prefix": whole[: len(prompt_ids)] == prompt_ids,
        "first_diff_index": first_diff,
        "generated_tokens": len(generated),
    }


def cmd_quality(args) -> None:
    out_dir = ROOT / ".runtime" / "b0" / "quality"
    out_dir.mkdir(parents=True, exist_ok=True)
    results = Results(f"quality_{Path(args.model).name}")
    transcripts = []
    model, processor = load(args)
    tokenizer = tokenizer_of(processor)

    def run(
        task: str,
        prompt: str,
        *,
        effort: str = "medium",
        seed: int = 0,
        max_tokens: int | None = None,
        **meta,
    ):
        params = NON_THINKING if effort == "none" else THINKING
        text, tokens, seconds, prompt_tokens, reason = generate(
            model,
            tokenizer,
            prompt,
            max_tokens=max_tokens or args.max_tokens,
            params=params,
            seed=seed,
        )
        parsed = split_output(text if effort != "none" else "</think>" + text)
        record = {
            "task": task,
            "effort": effort,
            "seed": seed,
            "prompt_tokens": prompt_tokens,
            "output_tokens": len(tokens),
            "reasoning_tokens": len(
                tokenizer.encode(parsed["reasoning"], add_special_tokens=False)
            ),
            "tool_calls": len(parsed["tool_calls"]),
            "malformed_calls": sum(1 for c in parsed["tool_calls"] if "malformed" in c),
            "stop": reason,
            "tok_s": round(len(tokens) / seconds, 2),
            **meta,
        }
        transcripts.append({**record, "prompt_tail": prompt[-600:], "output": text})
        return record, parsed, tokens

    base = [{"role": "system", "content": "You are a coding agent working in a small repository."}]

    # B0-12 agent tasks with the official template.
    tasks = {
        "format": [
            *base,
            {"role": "user", "content": "In one sentence: what does `git rebase` do?"},
        ],
        "tool_single": [
            *base,
            {"role": "user", "content": "Which files are in the repository root? Use a tool."},
        ],
        "tool_parallel": [
            *base,
            {
                "role": "user",
                "content": "Read README.md and AGENTS.md. Issue both tool calls in this one reply.",
            },
        ],
        "tool_followup": [
            *base,
            {"role": "user", "content": "How many lines does notes.txt have?"},
            {
                "role": "assistant",
                "reasoning_content": "Count lines with wc.",
                "content": "",
                "tool_calls": [
                    {
                        "type": "function",
                        "function": {
                            "name": "exec_command",
                            "arguments": {"cmd": "wc -l notes.txt"},
                        },
                    }
                ],
            },
            {"role": "tool", "content": "42 notes.txt"},
        ],
    }
    for task, messages in tasks.items():
        prompt = tokenizer.apply_chat_template(
            messages,
            tools=TOOLS,
            tokenize=False,
            add_generation_prompt=True,
            reasoning_effort="medium",
        )
        record, parsed, tokens = run(task, prompt)
        record["rerender"] = rerender_check(tokenizer, messages, prompt, tokens, thinking=True)
        if task == "tool_followup":
            record["mentions_42"] = "42" in parsed["content"]
        results.write({"kind": "quality", **record})
        emit(
            "READY",
            f"{task}: {json.dumps({k: record[k] for k in SUMMARY_KEYS})} "
            f"rerender={record['rerender']}",
        )

    def save_transcripts() -> None:
        stamp = time.strftime("%Y%m%d_%H%M%S")
        path = out_dir / f"{Path(args.model).name}_{stamp}.json"
        path.write_text(json.dumps(transcripts, indent=1, ensure_ascii=False))
        emit("INFO", f"Results: {results.path}; transcripts (test content only): {path}")

    if args.tasks_only:
        save_transcripts()
        return

    # Effort placement (D-17 rendering): official head placement versus mid-history segments.
    warmup = [
        *base,
        {"role": "user", "content": "Hi."},
        {"role": "assistant", "reasoning_content": "", "content": "Hello! What can I do?"},
    ]

    def history(head_effort: str) -> str:
        kwargs = (
            {"enable_thinking": False}
            if head_effort == "none"
            else {"reasoning_effort": head_effort}
        )
        return tokenizer.apply_chat_template(warmup, tools=TOOLS, tokenize=False, **kwargs)

    conditions = {
        "head_low": (history("low"), "low"),
        "head_medium": (history("medium"), "medium"),
        "head_xhigh": (history("xhigh"), "xhigh"),
        "mid_low": (history("medium") + segment(EFFORT_TEXT["low"]), "low"),
        "mid_xhigh": (history("medium") + segment(EFFORT_TEXT["xhigh"]), "xhigh"),
        "mid_down_xhigh_to_low": (history("xhigh") + segment(EFFORT_TEXT["low"]), "low"),
        "mid_up_low_to_medium": (history("low") + segment(EFFORT_TEXT["medium"]), "medium"),
        "mid_none": (history("medium") + segment(EFFORT_TEXT["none"]), "none"),
        "mid_low_as_user": (history("medium") + segment(EFFORT_TEXT["low"], "user"), "low"),
    }
    for name, (prefix, effort) in conditions.items():
        for seed in range(args.seeds):
            prompt = prefix + user_turn(PUZZLE) + gen_prompt(effort)
            record, parsed, _ = run(
                "effort",
                prompt,
                effort=effort,
                seed=seed,
                condition=name,
                max_tokens=args.effort_max_tokens,
            )
            record["correct"] = PUZZLE_ANSWER in parsed["content"]
            results.write({"kind": "quality", **record})
            emit(
                "READY",
                f"effort {name} seed {seed}: reasoning {record['reasoning_tokens']} tokens, "
                f"correct={record['correct']} stop={record['stop']}",
            )

    # Developer-role rendering candidates (plan 5.4): mid-history system versus user segment.
    instruction = "From now on, reply only in French."
    for name, prefix in {
        "no_instruction": history("medium"),
        "developer_as_system": history("medium") + segment(instruction),
        "developer_as_user": history("medium") + segment(instruction, "user"),
    }.items():
        prompt = (
            prefix
            + user_turn("What is the capital of Japan, and roughly how many people live there?")
            + gen_prompt("medium")
        )
        record, parsed, _ = run("developer", prompt, condition=name)
        record["looks_french"] = bool(
            re.search(r"\b(est|la|le|de|habitants|environ)\b", parsed["content"], re.I)
        )
        results.write({"kind": "quality", **record})
        emit("READY", f"developer {name}: looks_french={record['looks_french']}")

    save_transcripts()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    def add(name, handler):
        p = sub.add_parser(name)
        p.add_argument("--model", required=True)
        p.add_argument("--no-ple-prefetch", action="store_true", help="upstream serial PLE reads")
        p.set_defaults(handler=handler)
        return p

    p = add("curve", cmd_curve)
    p.add_argument("--contexts", default="2048,32768,131072,260096")
    p.add_argument("--step", type=int, default=2048)
    p.add_argument("--sweep-context", type=int, default=32768)
    p.add_argument("--sweep-steps", default="512,1024,4096")
    p.add_argument("--decode", type=int, default=128)

    p = add("snapshot", cmd_snapshot)
    p.add_argument("--lengths", default="8192,65536")
    p.add_argument("--boundary", type=float, default=0.75)
    p.add_argument("--step", type=int, default=2048)
    p.add_argument("--alt-step", type=int, default=1024)

    p = add("continuation", cmd_continuation)
    p.add_argument("--base", type=int, default=16384)
    p.add_argument("--steps", type=int, default=8)
    p.add_argument("--append", type=int, default=2048)
    p.add_argument("--generate", type=int, default=32)
    p.add_argument("--step", type=int, default=2048)

    p = add("mtp", cmd_mtp)
    p.add_argument("--draft", required=True)
    p.add_argument("--block-sizes", default="1,2,3")
    p.add_argument("--max-tokens", type=int, default=384)

    p = add("boundary", cmd_boundary)
    p.add_argument("--length", type=int, default=262144)
    p.add_argument("--decode", type=int, default=64)
    p.add_argument("--beyond", type=int, default=16)
    p.add_argument("--step", type=int, default=2048)

    p = add("quality", cmd_quality)
    p.add_argument("--max-tokens", type=int, default=2048)
    p.add_argument("--effort-max-tokens", type=int, default=6144)
    p.add_argument("--seeds", type=int, default=2)
    p.add_argument("--tasks-only", action="store_true", help="agent tasks only (e.g. the 27B)")

    args = parser.parse_args()
    started = time.monotonic()
    args.handler(args)
    emit("INFO", f"Finished in {(time.monotonic() - started) / 60:.1f} min.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
