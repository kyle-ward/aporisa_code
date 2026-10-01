"""SSD session cache (B2-1, P4) on the tiny model with its MTP drafter: spill, restore after
a restart, checks, capacity, privacy, and the engine paths that use it.

Blocks are 64 tokens here (2048 in service) so a few hundred tokens span several blocks.
"""

from __future__ import annotations

import stat
import time

import mlx.core as mx
import numpy as np
import pytest
from conftest import ALIAS, request, user, worker_init

from aporisa_backend.configs.engine import ENGINE
from aporisa_backend.engine import generate as gen
from aporisa_backend.engine.disk_cache import DiskCache

BLOCK = 64
TEXT = "The quick brown fox jumps over the lazy dog while the cat sleeps. "


@pytest.fixture(scope="module")
def engine(tiny_model_dir, tiny_draft_dir, tmp_path_factory):
    from aporisa_backend.engine import runtime

    root = tmp_path_factory.mktemp("kv") / "kv-cache"
    init = worker_init(
        tiny_model_dir,
        draft_dir=str(tiny_draft_dir),
        draft_schedule=[[0, 2]],
        kv_cache={"dir": str(root), "identity": "tiny", "draft_identity": "tiny-mtp"},
        engine={**ENGINE.as_dict(), "ssd_block_tokens": BLOCK},
    )
    engine = runtime.load(init)
    runtime.warmup(engine, ALIAS)
    assert engine.info["ssd_cache"] is True
    return engine


def open_disk(engine, root, **overrides) -> DiskCache:
    """A cache over `root` with the engine's layout: a fresh index, as after a restart."""
    base = engine.sessions.disk
    layout = {k: v for k, v in base.layout.items() if k not in ("format", "block_tokens")}
    options = {"capacity_bytes": base.capacity, "block_tokens": base.block_tokens, **overrides}
    return DiskCache(root, layout, **options)


@pytest.fixture
def disk(engine, tmp_path, monkeypatch):
    """A fresh, empty SSD cache for this test, used by the engine's session store."""
    cache = open_disk(engine, tmp_path / "kv-cache")
    monkeypatch.setattr(engine.sessions, "disk", cache)
    yield cache
    for key in [k for k in engine.sessions.sessions if not k.startswith("warmup")]:
        engine.sessions.release(key)


def words(engine, repeat: int, extra: str = "") -> list[int]:
    return engine.adapter.codec.encode(TEXT * repeat + extra)


def prefill(engine, key, tokens, stops=()):
    store = engine.sessions
    match = store.acquire(key, tokens)
    store.recall(match, tokens)
    engine._prefill(match.session, tokens, list(stops), gen.JobFlags(), 16)
    store.done(match.session)
    return match


def same_arrays(left, right) -> bool:
    left = [a for a in left if a is not None]
    right = [a for a in right if a is not None]
    return len(left) == len(right) and all(
        a.shape == b.shape and a.dtype == b.dtype and bool(mx.array_equal(a, b))
        for a, b in zip(left, right, strict=True)
    )


def same_caches(left: list, right: list) -> bool:
    """Same recurrent states and KV; an attention cache's indexer block summaries (slots
    4, 5) are derived and rebuilt after a restore, so they are not compared."""
    return len(left) == len(right) and all(
        same_arrays(list(a.state)[:4], list(b.state)[:4]) for a, b in zip(left, right, strict=True)
    )


def test_a_restored_session_is_the_session_that_was_spilled(engine, disk, monkeypatch):
    tokens = words(engine, 16)
    assert len(tokens) > 3 * BLOCK + 10
    mid = 2 * BLOCK + 7
    original = prefill(engine, "spill-a", tokens, [mid]).session
    assert disk.spill(original, engine.drafter) > 0 and disk.stats.errors == 0
    assert sorted(c.offset for c in disk.checkpoints.values()) == [mid, len(tokens)]
    assert len(disk.blocks) == len(tokens) // BLOCK

    again = open_disk(engine, disk.root)  # a restart: the index is read back from disk
    assert again.checkpoints.keys() == disk.checkpoints.keys()
    more = tokens + engine.adapter.codec.encode(" Then the dog wakes up and barks loudly.")
    store = engine.sessions
    restored = again.restore(more, 0, store.make_cache, engine.drafter)
    assert restored is not None and restored.offset == len(tokens)
    assert same_caches(original.cache, restored.cache)
    assert same_caches(original.draft.cache, restored.draft.cache)
    assert same_arrays(
        [original.logits, original.draft.hidden], [restored.logits, restored.draft.hidden]
    )

    # Continuing from disk computes exactly what continuing in memory does.
    monkeypatch.setattr(store, "disk", again)
    from_disk = prefill(engine, "spill-b", more)
    assert (from_disk.path, from_disk.cached) == ("ssd", len(tokens))
    in_memory = prefill(engine, "spill-a", more)
    assert (in_memory.path, in_memory.cached) == ("live", len(tokens))
    assert same_arrays([from_disk.session.logits], [in_memory.session.logits])
    assert same_caches(from_disk.session.draft.cache, in_memory.session.draft.cache)


@pytest.mark.parametrize("mid", [2 * BLOCK + 7, 2 * BLOCK], ids=["tail", "block-edge"])
def test_a_request_diverging_after_the_snapshot_restores_there(engine, disk, mid):
    tokens = words(engine, 16)
    disk.spill(prefill(engine, "div-a", tokens, [mid]).session, engine.drafter)
    other = tokens[:mid] + engine.adapter.codec.encode(" Something else entirely happens.")
    match = prefill(engine, "div-b", other)
    assert disk.stats.errors == 0
    assert (match.path, match.cached) == ("ssd", mid)
    assert match.load_ms is not None
    # nothing on disk is deeper than what memory holds by a block: memory wins
    live = prefill(engine, "div-b", other + engine.adapter.codec.encode(" More."))
    assert live.path == "live"


def test_a_session_spilled_again_writes_only_its_new_blocks(engine, disk):
    tokens = words(engine, 8)
    session = prefill(engine, "grow", tokens).session
    disk.spill(session, engine.drafter)
    blocks, checkpoints = set(disk.blocks), set(disk.checkpoints)
    assert disk.spill(session, engine.drafter) == 0  # unchanged: nothing to write
    longer = tokens + words(engine, 8)  # a continuation: the same tokens, then more
    prefill(engine, "grow", longer)
    written = disk.spill(session, engine.drafter)
    added = set(disk.blocks) - blocks
    assert blocks < set(disk.blocks)
    assert len(added) == len(longer) // BLOCK - len(tokens) // BLOCK
    # exactly the new blocks and the new checkpoints, nothing rewritten
    new_checkpoints = set(disk.checkpoints) - checkpoints
    assert written == sum(disk.blocks[b] for b in added) + sum(
        disk.checkpoints[c].nbytes for c in new_checkpoints
    )


def test_damaged_files_are_deleted_and_the_prompt_prefilled(engine, disk):
    tokens = words(engine, 16)
    disk.spill(prefill(engine, "bad", tokens, [2 * BLOCK + 7]).session, engine.drafter)
    first = disk.chain(np.asarray(tokens, dtype=np.int32), 1)[1].hex()
    path = disk.block_dir / f"{first}.blk"
    data = bytearray(path.read_bytes())
    data[-1] ^= 0x01
    path.write_bytes(bytes(data))
    store = engine.sessions
    assert disk.restore(tokens + [11, 12], 0, store.make_cache, engine.drafter) is None
    assert disk.stats.errors == 2 and not disk.checkpoints  # both checkpoints use block 1
    match = prefill(engine, "bad-again", tokens)
    assert match.path == "cold"


def test_a_truncated_checkpoint_is_not_used(engine, disk):
    tokens = words(engine, 6)
    disk.spill(prefill(engine, "cut", tokens).session, engine.drafter)
    [checkpoint] = disk.checkpoints.values()
    path = disk.checkpoint_dir / f"{checkpoint.key}.ckpt"
    path.write_bytes(path.read_bytes()[:-100])
    again = open_disk(engine, disk.root)
    store = engine.sessions
    assert again.restore(tokens + [5], 0, store.make_cache, engine.drafter) is None
    assert not again.checkpoints and not path.exists()


def test_another_layout_is_neither_read_nor_kept(engine, disk):
    tokens = words(engine, 6)
    disk.spill(prefill(engine, "layout", tokens).session, engine.drafter)
    layout = {k: v for k, v in disk.layout.items() if k not in ("format", "block_tokens")}
    other = DiskCache(
        disk.root, {**layout, "mlx": "0.0.0"}, capacity_bytes=disk.capacity, block_tokens=BLOCK
    )
    assert not other.checkpoints and not other.blocks
    assert not disk.dir.exists() and other.dir.is_dir()


def test_capacity_drops_the_least_recently_used(engine, disk, tmp_path):
    first, second = words(engine, 8), words(engine, 8, "And a different ending here.")[::-1]
    a = prefill(engine, "cap-a", first).session
    b = prefill(engine, "cap-b", second).session
    disk.spill(a, engine.drafter)
    size = disk.total_bytes()
    small = open_disk(engine, tmp_path / "small", capacity_bytes=int(size * 1.5))
    small.spill(a, engine.drafter)
    time.sleep(0.01)
    small.spill(b, engine.drafter)
    assert small.total_bytes() <= small.capacity
    assert {c.offset for c in small.checkpoints.values()} == {len(second)}
    store = engine.sessions
    assert small.restore(first + [7], 0, store.make_cache, engine.drafter) is None
    assert small.restore(second + [7], 0, store.make_cache, engine.drafter) is not None
    # a session larger than the whole cache is not written at all
    tiny = open_disk(engine, tmp_path / "tiny", capacity_bytes=size // 4)
    assert tiny.spill(a, engine.drafter) == 0 and tiny.total_bytes() == 0


def test_files_hold_no_tokens_or_text_and_are_private(engine, disk):
    tokens = words(engine, 16)
    disk.spill(prefill(engine, "private", tokens, [2 * BLOCK + 7]).session, engine.drafter)
    runs = [
        np.asarray(tokens[i : i + 8], dtype="<i4").tobytes() for i in range(0, len(tokens) - 8, 37)
    ]
    text = TEXT.encode()
    files = [p for p in disk.root.rglob("*") if p.is_file()]
    assert len(files) == len(disk.blocks) + len(disk.checkpoints) + 1  # + layout.json
    for path in disk.root.rglob("*"):
        mode = stat.S_IMODE(path.stat().st_mode)
        if path.is_dir():
            assert mode == 0o700
            continue
        assert mode == 0o600
        data = path.read_bytes()
        assert text not in data and text[:24] not in data
        assert not any(run in data for run in runs)


def test_graceful_stop_writes_idle_sessions_newest_first(engine, disk):
    store = engine.sessions
    prefill(engine, "stop-a", words(engine, 6))
    prefill(engine, "stop-b", words(engine, 6, "Another one."))
    prefill(engine, "short", words(engine, 1))  # under one block: nothing to write
    store.spill_all(time.monotonic() - 1)  # no time left: nothing written
    assert not disk.checkpoints
    store.spill_all(time.monotonic() + 30)
    assert len(disk.checkpoints) == 2 and disk.stats.spills == 2


def test_an_evicted_session_comes_back_from_ssd(engine, disk, monkeypatch):
    store = engine.sessions
    monkeypatch.setattr(store, "_budget", 0)  # every other idle session must leave memory
    long_input = {"input": [user(TEXT * 10)], "max_output_tokens": 6}
    first = {**request(), **long_input, "reasoning": {"effort": "none"}}
    other = {**first, "input": [user(TEXT * 9 + "Something else.")]}

    def run(body, key):
        messages: list[dict] = []
        engine.generate(
            {"id": "t", "request": body, "session": key}, messages.append, gen.JobFlags()
        )
        return messages

    assert run(first, "ev-a")[0]["restore_path"] == "cold"
    evicting = run(other, "ev-b")
    assert "ev-a" not in store.sessions
    metrics = evicting[-1]["metrics"]
    assert metrics["ssd_spill_count"] == 1 and metrics["ssd_bytes_written"] > 0
    back = run(first, "ev-a")
    accepted = back[0]
    assert accepted["restore_path"] == "ssd"
    assert accepted["cached_tokens"] == accepted["input_tokens"]  # the prompt-end checkpoint
    assert back[-1]["type"] == "finished" and back[-1]["metrics"]["ssd_load_ms"] is not None
    status = store.status()
    assert status["ssd_checkpoints"] >= 2 and status["ssd_written_bytes"] > 0
