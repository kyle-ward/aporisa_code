"""Shared helpers for the B0 measurement scripts (DEVELOPMENT_PLAN.md B0).

Everything here drives mlx-vlm's qwen4_exp language model directly: explicit text positions,
chunked prefill, and cache snapshots (DeltaNet state copies plus KV truncation), which is
the mechanism section 6 of the plan relies on.
"""

from __future__ import annotations

import json
import os
import platform
import time
from pathlib import Path

import mlx.core as mx

ROOT = Path(__file__).resolve().parents[2]
RESULTS = ROOT / ".runtime" / "b0" / "results"
# Same allocator cache bound local_llm uses on the Mac; freed buffers beyond it go back to macOS.
CACHE_LIMIT_BYTES = 2 * 1024**3


def emit(tag: str, message: str) -> None:
    prefix = "ERROR:" if tag == "ERROR" else f"[{tag}]"
    print(f"[Aporisa Code] {prefix} {message}", flush=True)


def gib(value: float) -> float:
    return round(value / 1024**3, 2)


class Results:
    """Appends one JSON object per measurement; never stores prompt or output text."""

    def __init__(self, name: str):
        RESULTS.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d_%H%M%S")
        self.path = RESULTS / f"{name}_{stamp}.jsonl"
        self.write({"kind": "environment", **environment()})

    def write(self, record: dict) -> None:
        with self.path.open("a") as stream:
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")


def environment() -> dict:
    import mlx_vlm

    info = mx.device_info()
    return {
        "time": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "macos": platform.mac_ver()[0],
        "mlx": mx.__version__,
        "mlx_vlm": mlx_vlm.__version__,
        "device": info.get("device_name"),
        "memory_bytes": info.get("memory_size"),
        "recommended_working_set_bytes": info.get("max_recommended_working_set_size"),
    }


def load_model(path: str):
    """Loads a converted checkpoint offline; returns (model, processor)."""
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
    from mlx_vlm import load

    # MLX wires nothing by default (limit 0); mlx-vlm raises the limit only inside its own
    # generate loop. Without this, macOS compresses and swaps the 60+ GiB of weights and
    # prefill collapses by an order of magnitude.
    wired = mx.device_info()["max_recommended_working_set_size"]
    mx.set_wired_limit(wired)
    mx.set_cache_limit(CACHE_LIMIT_BYTES)
    started = time.monotonic()
    model, processor = load(path)
    mx.eval(model.parameters())
    emit(
        "READY",
        f"Loaded {Path(path).name} in {time.monotonic() - started:.0f}s; "
        f"active {gib(mx.get_active_memory())} GiB; wired limit {gib(wired)} GiB.",
    )
    return model, processor


def text_positions(offset: int, length: int) -> mx.array:
    """Text-only M-RoPE positions: all three sections equal offset..offset+length-1.

    Passing positions explicitly keeps each call independent of the position state that
    Qwen3.5-family language models cache on the module (`_position_ids`, `_rope_deltas`);
    without it a cache restored to offset > 0 would restart positions at 0.
    """
    row = mx.arange(offset, offset + length, dtype=mx.int32)[None, None, :]
    return mx.broadcast_to(row, (3, 1, length))


def cache_offset(cache: list) -> int:
    return max(int(getattr(entry, "offset", 0) or 0) for entry in cache)


def forward(lm, cache: list, tokens: list[int], *, keep: int = 1) -> mx.array:
    """One forward call appending `tokens` to `cache`; returns logits of the last `keep`."""
    offset = cache_offset(cache)
    ids = mx.array([tokens], dtype=mx.int32)
    out = lm(
        ids, cache=cache, position_ids=text_positions(offset, len(tokens)), logits_to_keep=keep
    )
    return out.logits[:, -keep:, :]


def prefill(lm, cache: list, tokens: list[int], step: int, *, on_chunk=None) -> mx.array:
    """Chunked prefill of all `tokens`; returns logits of the final token (float32)."""
    logits = None
    for start in range(0, len(tokens), step):
        chunk = tokens[start : start + step]
        logits = forward(lm, cache, chunk)
        mx.eval(logits, [entry.state for entry in cache])
        if on_chunk:
            on_chunk(start + len(chunk))
        mx.clear_cache()
    return logits[0, -1].astype(mx.float32)


def snapshot(cache: list) -> dict:
    """Snapshot = copies of the fixed-size recurrent states plus the current length.

    KV caches are not copied; restore truncates them. mx arrays are immutable values, so
    holding the references is a real copy of the recurrent state at this point.
    """
    from mlx_vlm.models.cache import ArraysCache

    states = {
        i: list(entry.state) for i, entry in enumerate(cache) if isinstance(entry, ArraysCache)
    }
    mx.eval([v for state in states.values() for v in state if v is not None])
    return {"offset": cache_offset(cache), "states": states}


def snapshot_bytes(snap: dict) -> int:
    return sum(v.nbytes for state in snap["states"].values() for v in state if v is not None)


def restore(cache: list, snap: dict) -> None:
    """Returns the cache to the snapshot position: truncate KV, put back recurrent states."""
    from mlx_vlm.models.cache import ArraysCache

    target = snap["offset"]
    for index, entry in enumerate(cache):
        if isinstance(entry, ArraysCache):
            entry.state = list(snap["states"][index])
        else:
            excess = int(entry.offset) - target
            if excess < 0:
                raise ValueError("cannot restore forward: KV is shorter than the snapshot")
            if excess:
                entry.trim(excess)
    if cache_offset(cache) != target:
        raise ValueError("restore did not reach the snapshot offset")


def corpus_tokens(tokenizer, count: int) -> list[int]:
    """Deterministic natural-ish token stream: repository docs and code, repeated.

    Uses only files tracked in this repository (no private data). Repetition keeps the
    stream long enough for 262K contexts; PLE n-gram lookups still see real text.
    """
    sources = sorted(
        [
            *ROOT.glob("docs/*.md"),
            *ROOT.glob("aporisa_code/src/**/*.ts"),
            ROOT / "AGENTS.md",
            ROOT / "README.md",
        ]
    )
    text = "\n\n".join(path.read_text() for path in sources if path.is_file())
    base = tokenizer.encode(text, add_special_tokens=False)
    tokens: list[int] = []
    while len(tokens) < count:
        tokens.extend(base)
    return tokens[:count]


PAGE_BYTES = 16 * 1024


def ple_table(model):
    """The external PLE row store, or None when the table is resident."""
    from mlx_vlm.models.qwen4_exp.ple_storage import QuantizedMMapNGramEmbedding

    for layer in model.language_model.model.layers:
        ple = getattr(layer, "ple", None)
        table = getattr(getattr(ple, "ple_embedding", None), "ngram_embedding", None)
        if isinstance(table, QuantizedMMapNGramEmbedding):
            return table
    return None


def row_pages(table, row_ids) -> dict:
    """Page-aligned offsets, per file, of the weight/scales/biases bytes of `row_ids`."""
    import numpy as np

    row_ids = np.asarray(row_ids, dtype=np.int64)
    pages: dict[str, list] = {}
    for start, end, arrays in table._shards:
        local = row_ids[(row_ids >= start) & (row_ids < end)] - start
        if not local.size:
            continue
        for array in arrays.values():
            offsets = (array.offset + local * array.strides[0]) // PAGE_BYTES * PAGE_BYTES
            pages.setdefault(array.filename, []).append(offsets)
    return {name: np.unique(np.concatenate(parts)) for name, parts in pages.items()}


class PlePrefetch:
    """Touches the pages of each lookup with a thread pool before the upstream reader runs.

    The upstream reader gathers rows with numpy fancy indexing, which faults the pages in
    one at a time (queue depth 1). Prefetching at queue depth > 1 is the B0 stand-in for the
    worker's own row store; it is still synchronous, not overlapped with GPU compute.
    """

    def __init__(self, table, workers: int = 64):
        from concurrent.futures import ThreadPoolExecutor

        self.table, self.pool = table, ThreadPoolExecutor(workers)
        files = {array.filename for _, _, arrays in table._shards for array in arrays.values()}
        self.fds = {name: os.open(name, os.O_RDONLY) for name in files}
        self.seconds = 0.0
        original = table._read_rows

        def read_rows(row_ids):
            started = time.perf_counter()
            jobs = [
                (self.fds[name], int(offset))
                for name, offsets in row_pages(table, row_ids).items()
                for offset in offsets
            ]
            list(self.pool.map(lambda job: os.pread(job[0], PAGE_BYTES, job[1]), jobs))
            self.seconds += time.perf_counter() - started
            return original(row_ids)

        table._read_rows = read_rows


def enable_ple_prefetch(model, workers: int = 64) -> PlePrefetch | None:
    table = ple_table(model)
    if table is None:
        return None
    emit("INFO", f"PLE prefetch enabled ({workers} threads); pass --no-ple-prefetch to disable.")
    return PlePrefetch(table, workers)


def tokenizer_of(processor):
    return processor.tokenizer if hasattr(processor, "tokenizer") else processor
