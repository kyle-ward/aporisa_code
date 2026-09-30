"""Worker engine on the tiny model, in process: sessions, snapshots, PLE ids, generation.

The tiny model is random, so content-dependent tests script the sampled tokens while every
forward pass still runs through the real model, cache and PLE reader.
"""

from __future__ import annotations

import mlx.core as mx
import numpy as np
import pytest
from conftest import ALIAS, request, user, worker_init

from aporisa_backend.engine import generate as gen
from aporisa_backend.engine.adapters.qwen38 import END_OF_TEXT


@pytest.fixture(scope="module")
def engine(tiny_model_dir):
    from aporisa_backend.engine import runtime

    engine = runtime.load(worker_init(tiny_model_dir))
    runtime.warmup(engine, ALIAS)
    return engine


@pytest.fixture
def script(monkeypatch, engine):
    """script(text): the next generations sample exactly these tokens, then <|im_end|>."""

    def use(text: str):
        tokens = engine.adapter.codec.encode(text)
        state = {"index": 0}

        def sample(self, logits):
            token = tokens[min(state["index"], len(tokens) - 1)]
            state["index"] += 1
            return token

        monkeypatch.setattr(gen.Sampler, "__call__", sample)
        return tokens

    return use


def run(engine, body: dict, session: str | None = None, flags=None) -> list[dict]:
    messages: list[dict] = []
    engine.generate(
        {"id": "t", "request": body, "session": session}, messages.append, flags or gen.JobFlags()
    )
    return messages


def items_of(messages):
    return [m["item"] for m in messages if m["type"] == "item_done"]


def as_input(items):
    """Output items as the harness sends them back (with ids and call ids)."""
    back = []
    for index, item in enumerate(items):
        if item["type"] == "message":
            back.append({**item, "id": f"msg_{index}", "role": "assistant"})
        elif item["type"] == "reasoning":
            back.append({**item, "id": f"rs_{index}", "summary": [], "encrypted_content": None})
        else:
            back.append({**item, "id": f"fc_{index}", "call_id": f"call_{index}"})
    return back


def test_ple_row_ids_match_the_model(engine):
    prefetcher = engine.prefetcher
    table = prefetcher.table
    seen: list[np.ndarray] = []
    inner = table._read_rows

    def record(row_ids):
        seen.append(np.asarray(row_ids, dtype=np.int64))
        return inner(row_ids)

    table._read_rows = record
    try:
        cache = engine.lm.make_cache()
        first = [11, 22, 33, END_OF_TEXT, 44, 55, END_OF_TEXT, END_OF_TEXT, 66]
        second = [77, END_OF_TEXT, 88, 99]
        engine._forward(cache, first)
        engine._forward(cache, second)
    finally:
        table._read_rows = inner
    ids = prefetcher.row_ids
    assert np.array_equal(seen[0], np.unique(ids(ids.window([]), first)))
    assert np.array_equal(seen[1], np.unique(ids(ids.window(first), second)))


def test_snapshot_restore_is_bit_exact(engine):
    store = engine.sessions
    codec = engine.adapter.codec
    tokens = codec.encode("The quick brown fox jumps over the lazy dog. " * 12)
    mid = len(tokens) // 2
    flags = gen.JobFlags()

    match = store.acquire("exact", tokens)
    engine._prefill(match.session, tokens, [mid], flags, 16)
    reference = np.array(match.session.logits.astype(mx.float32))
    store.done(match.session)

    other = tokens[:mid] + codec.encode(" Something else entirely.")
    match = store.acquire("exact", other)
    assert (match.path, match.cached) == ("snapshot", mid)
    engine._prefill(match.session, other, [], flags, 16)
    store.done(match.session)

    match = store.acquire("exact", tokens)
    assert (match.path, match.cached) == ("snapshot", mid)
    engine._prefill(match.session, tokens, [], flags, 16)
    assert np.array_equal(np.array(match.session.logits.astype(mx.float32)), reference)
    store.done(match.session)

    cold = store.acquire(None, tokens)
    engine._prefill(cold.session, tokens, [mid], flags, 16)
    assert np.array_equal(np.array(cold.session.logits.astype(mx.float32)), reference)
    store.done(cold.session)
    store.release("exact")


def test_generation_items_usage_and_live_continuation(engine, script):
    generated = script("Thinking it over.\n</think>\n\nHello there.<|im_end|>")
    first = request("hi", reasoning={"effort": "medium"})
    messages = run(engine, first, "live")
    accepted, finished = messages[0], messages[-1]
    assert accepted["type"] == "accepted" and accepted["restore_path"] == "cold"
    assert finished["status"] == "completed"
    items = items_of(messages)
    assert [i["type"] for i in items] == ["reasoning", "message"]
    assert items[1]["phase"] == "final_answer"
    usage = finished["usage"]
    assert usage["output_tokens"] == len(generated)
    assert usage["total_tokens"] == usage["input_tokens"] + usage["output_tokens"]
    assert 0 < usage["output_tokens_details"]["reasoning_tokens"] < len(generated)

    script("\n</think>\n\nAgain.<|im_end|>")
    second = {**first, "input": [*first["input"], *as_input(items), user("more")]}
    accepted = run(engine, second, "live")[0]
    assert accepted["restore_path"] == "live"
    # The live cache holds the prompt plus every generated token but the final <|im_end|>.
    assert accepted["cached_tokens"] == usage["input_tokens"] + len(generated) - 1
    assert engine.count(second) == accepted["input_tokens"]
    engine.sessions.release("live")


def test_prewarm_then_identical_request_reuses_everything(engine, script):
    script("\n</think>\n\nOK<|im_end|>")
    body = request("prewarm me")
    warm = run(engine, {**body, "generate": False}, "warm")
    assert [m["type"] for m in warm] == ["accepted", "finished"]
    assert warm[-1]["usage"]["output_tokens"] == 0
    again = run(engine, body, "warm")
    assert again[0]["restore_path"] == "live"
    assert again[0]["cached_tokens"] == again[0]["input_tokens"]
    assert again[-1]["status"] == "completed"
    engine.sessions.release("warm")


def test_retry_of_the_same_request_reuses_the_whole_prompt(engine, script):
    script("\n</think>\n\nFirst.<|im_end|>")
    body = request("retry me")
    first = run(engine, body, "retry")
    # The live cache now also holds the generated turn; the prompt-end snapshot kept its
    # logits, so an identical retry restores it and prefills nothing.
    again = run(engine, body, "retry")
    assert again[0]["restore_path"] == "snapshot"
    assert again[0]["cached_tokens"] == first[0]["input_tokens"] == again[0]["input_tokens"]
    assert again[-1]["status"] == "completed"
    engine.sessions.release("retry")


def test_tool_call_and_parallel_stop(engine, script):
    tools = [
        {
            "type": "function",
            "name": "exec_command",
            "parameters": {"type": "object", "properties": {"cmd": {"type": "string"}}},
        }
    ]
    script(
        "\n</think>\n\n<tool_call>\n<function=exec_command>\n<parameter=cmd>\nls\n</parameter>\n"
        "</function>\n</tool_call>\n<tool_call>\n<function=exec_command>\n"
    )
    messages = run(engine, request("list", tools=tools))
    assert items_of(messages) == [
        {"type": "function_call", "name": "exec_command", "arguments": '{"cmd": "ls"}'}
    ]
    assert messages[-1]["status"] == "completed"


def test_broken_tool_call_fails_with_detail(engine, script):
    script("\n</think>\n\n<tool_call>\n</tool_call><|im_end|>")
    messages = run(engine, request("x"))
    assert messages[-1] == {
        "id": "t",
        "type": "failed",
        "code": "tool_call_invalid",
        "detail": "no_function",
    }


def test_limits_interrupt_cancel_and_rejection(engine, script):
    script("word " * 50)
    capped = run(engine, request("x", max_output_tokens=5))
    assert capped[-1]["status"] == "incomplete" and capped[-1]["reason"] == "max_output_tokens"
    assert capped[-1]["usage"]["output_tokens"] == 5

    flags = gen.JobFlags()
    flags.interrupt.set()
    interrupted = run(engine, request("x"), flags=flags)
    assert interrupted[-1]["reason"] == "interrupted"
    assert interrupted[-1]["usage"]["output_tokens"] == 0

    flags = gen.JobFlags()
    flags.cancel.set()
    with pytest.raises(gen.Cancelled):
        run(engine, request("x"), flags=flags)

    window = engine.settings.context_window
    assert [m["type"] for m in run(engine, request("x", max_output_tokens=window))] == ["rejected"]


def test_budget_evicts_idle_sessions(engine, script):
    script("\n</think>\n\nOK<|im_end|>")
    store = engine.sessions
    saved = store.budget_bytes
    try:
        run(engine, request("first"), "a")
        store.budget_bytes = 1
        run(engine, request("second"), "b")
        assert "a" not in store.sessions and "b" in store.sessions
    finally:
        store.budget_bytes = saved
        store.release("b")


def test_metrics_report_memory_pressure_and_chunk_time(engine, script):
    script("\n</think>\n\nOK<|im_end|>")
    finished = run(engine, request("pressure"))[-1]
    metrics = finished["metrics"]
    for key in ("sys_swapouts", "sys_compressions", "swap_growth_bytes", "major_faults"):
        assert isinstance(metrics[key], int)
    assert metrics["prefill_max_chunk_ms"] >= 0 and metrics["compressor_bytes"] >= 0
    assert engine.info["released_cache_bytes"] >= 0


def test_prefetch_wait_stays_responsive():
    import concurrent.futures
    import time

    never = concurrent.futures.Future()
    flags = gen.JobFlags()
    flags.cancel.set()
    started = time.monotonic()
    with pytest.raises(gen.Cancelled):
        gen.Engine._wait(never, flags)
    flags = gen.JobFlags()
    flags.interrupt.set()
    assert gen.Engine._wait(never, flags) is False
    assert time.monotonic() - started < 1
    done = concurrent.futures.Future()
    done.set_result(None)
    assert gen.Engine._wait(done, gen.JobFlags()) is True


def test_layerwise_load_matches_a_one_shot_load(engine, tiny_model_dir):
    """runtime.load materializes layer by layer, releasing page cache as it goes (B)."""
    from mlx_vlm.utils import load_model

    eager = load_model(tiny_model_dir, lazy=False).language_model
    tokens = engine.adapter.codec.encode("Layer by layer, the same weights. " * 8)

    def logits(lm):
        logits, _ = gen.Engine._forward(engine, lm.make_cache(), tokens)
        return np.array(logits.astype(mx.float32))

    staged = logits(engine.lm)
    engine_lm, engine.lm = engine.lm, eager
    try:
        assert np.array_equal(logits(eager), staged)
    finally:
        engine.lm = engine_lm


def test_session_budget_follows_available_memory(monkeypatch):
    """C1: the budget is what the model can hold without taking the desktop's memory."""
    import types

    import psutil

    from aporisa_backend.configs.engine import ENGINE
    from aporisa_backend.engine import runtime

    gib = 1024**3
    available = {"bytes": 10 * gib}
    monkeypatch.setattr(
        psutil, "virtual_memory", lambda: types.SimpleNamespace(available=available["bytes"])
    )
    monkeypatch.setattr(mx, "get_cache_memory", lambda: 0)
    budget = runtime.session_budget(wired=85 * gib, weights=67 * gib, config=ENGINE)
    store = types.SimpleNamespace(total_bytes=lambda: 1 * gib)
    reserves = (
        ENGINE.activation_reserve_bytes + ENGINE.cache_limit_bytes + ENGINE.desktop_margin_bytes
    )
    assert budget(store) == 10 * gib + 1 * gib - reserves
    available["bytes"] = 8 * gib  # the desktop grew: the budget shrinks with it
    assert budget(store) == 9 * gib - reserves
    available["bytes"] = 60 * gib  # plenty free: still capped by the wired limit
    ceiling = 85 * gib - 67 * gib - ENGINE.activation_reserve_bytes - ENGINE.safety_margin_bytes
    assert budget(store) == ceiling


def test_session_store_evaluates_a_callable_budget(engine, script):
    script("\n</think>\n\nOK<|im_end|>")
    store = engine.sessions
    saved = store._budget
    calls = []
    try:
        store.budget_bytes = lambda s: calls.append(s.total_bytes()) or -5
        assert store.budget_bytes == 0  # clamped
        run(engine, request("callable budget"), "cb")
        assert calls  # evaluated when making room for the request
    finally:
        store.budget_bytes = saved
        store.release("cb")


def test_session_memory_is_what_session_bytes_reports(engine):
    """A prefilled session holds its caches, snapshots and one logits row, nothing more (the
    kept row used to pin the whole chunk's logits, ~1 GB per session and per snapshot)."""
    import gc

    def active():
        gc.collect()
        mx.synchronize()
        mx.clear_cache()
        return mx.get_active_memory()

    tokens = [(i * 7919) % 200_000 + 1000 for i in range(2048)]
    before = active()
    match = engine.sessions.acquire("pinned", tokens)
    engine._prefill(match.session, tokens, [1024], gen.JobFlags(), 16)
    engine.sessions.done(match.session)
    reported = match.session.nbytes()
    held = active() - before
    engine.sessions.release("pinned")
    assert abs(held - reported) < 64 * 1024**2, (held, reported)


def test_memory_pressure_drops_idle_sessions(engine, script, monkeypatch):
    """Under the kernel's warn level a request first drops every idle session, and an idle
    worker drops one per check (Worker._relieve_pressure)."""
    from aporisa_backend import vmstats

    script("\n</think>\n\nOK<|im_end|>")
    store = engine.sessions
    run(engine, request("first"), "p1")
    run(engine, request("second"), "p2")
    level = {"value": vmstats.PRESSURE_WARN}
    monkeypatch.setattr(vmstats, "pressure_level", lambda: level["value"])
    before = store.pressure_evictions
    run(engine, request("third"), "p3")
    assert set(store.sessions) == {"p3"} and store.pressure_evictions == before + 2
    assert store.shed() is True and store.shed() is False  # p3 is idle now; then nothing left
    level["value"] = vmstats.PRESSURE_NORMAL
    run(engine, request("fourth"), "p4")
    run(engine, request("fifth"), "p5")
    assert {"p4", "p5"} <= set(store.sessions)
    store.release("p4")
    store.release("p5")
