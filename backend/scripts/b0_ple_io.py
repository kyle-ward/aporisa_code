"""B0-5 follow-up: random-row read throughput of the external PLE table (file I/O only).

No model weights are loaded. Compares, for batches of random rows the size of one 2K-token
prefill chunk (2048 tokens x 16 n-gram lookups):
  cold      the upstream reader on rows not read before (serial page faults)
  warm      the same rows again (page cache)
  prefetch  fresh rows whose pages were first touched by a thread pool (queue depth > 1),
            then read by the upstream reader
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from b0_lib import PAGE_BYTES, Results, emit, row_pages  # noqa: E402


def prefetch(pages: dict, workers: int) -> None:
    descriptors = {name: os.open(name, os.O_RDONLY) for name in pages}
    jobs = [
        (descriptors[name], int(offset)) for name, offsets in pages.items() for offset in offsets
    ]
    try:
        with ThreadPoolExecutor(workers) as pool:
            list(pool.map(lambda job: os.pread(job[0], PAGE_BYTES, job[1]), jobs))
    finally:
        for fd in descriptors.values():
            os.close(fd)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model", required=True, help="external-PLE view directory")
    parser.add_argument("--rows", type=int, default=2048 * 16)
    parser.add_argument("--workers", type=int, default=32)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()
    from mlx_vlm.models.qwen4_exp.ple_storage import QuantizedMMapNGramEmbedding

    table = QuantizedMMapNGramEmbedding(Path(args.model) / "ple-store.json", cache_rows=0)
    rng = np.random.default_rng(args.seed)
    results = Results("ple_io")

    def batch() -> np.ndarray:
        return np.unique(rng.integers(0, table.row_count, size=args.rows))

    def timed(ids: np.ndarray) -> float:
        started = time.perf_counter()
        table(ids.reshape(1, -1))
        return time.perf_counter() - started

    cold_ids = batch()
    cold = timed(cold_ids)
    warm = timed(cold_ids)
    fresh = batch()
    pages = row_pages(table, fresh)
    started = time.perf_counter()
    prefetch(pages, args.workers)
    prefetch_s = time.perf_counter() - started
    after = timed(fresh)
    row = {
        "kind": "ple_io",
        "rows": int(cold_ids.size),
        "pages_per_batch": sum(len(v) for v in pages.values()),
        "cold_s": round(cold, 3),
        "warm_s": round(warm, 4),
        "prefetch_s": round(prefetch_s, 3),
        "read_after_prefetch_s": round(after, 4),
        "workers": args.workers,
        "cold_rows_per_s": round(cold_ids.size / cold),
        "prefetch_rows_per_s": round(fresh.size / (prefetch_s + after)),
    }
    results.write(row)
    emit("READY", f"{row}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
