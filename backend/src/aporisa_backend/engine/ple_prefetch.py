"""PLE page prefetch (DEVELOPMENT_PLAN.md 7, 14.5, B1-10).

The upstream external-PLE reader gathers each lookup's rows with numpy fancy indexing over
memmaps, faulting pages in one at a time. Row ids are a pure function of the tokens, so:

- prefill: while the GPU runs chunk i, a thread pool preads the pages chunk i+1 will read;
  the upstream reader then hits the page cache;
- decode: the next token is unknown until sampled, so each lookup first touches its pages
  concurrently (queue depth > 1) before the upstream reader runs (B0's approach).

`row_ids` replicates Qwen4ExpNGramEmbedding's id computation in numpy (multipliers, per-head
prime vocab sizes and offsets, the window reset after <|endoftext|>); a test checks it
against the ids the model itself asks for.
"""

from __future__ import annotations

import os
import threading
from concurrent.futures import Future, ThreadPoolExecutor

import numpy as np

PAGE_BYTES = 16 * 1024


def external_ple(lm):
    """(ngram module, external table) or None when the PLE table is resident."""
    from mlx_vlm.models.qwen4_exp.ple_storage import QuantizedMMapNGramEmbedding

    for layer in lm.model.layers:
        if "ple" not in layer:
            continue
        module = layer.ple.ple_embedding
        if isinstance(module.ngram_embedding, QuantizedMMapNGramEmbedding):
            return module, module.ngram_embedding
    return None


class RowIds:
    """numpy twin of Qwen4ExpNGramEmbedding's row-id computation."""

    def __init__(self, module):
        self.context_len = module.context_len
        self.ngram_size = module.ngram_size
        self.heads = module.heads_per_ngram
        self.eos = int(module.eos_token_id)
        self.multipliers = np.array(module.layer_multipliers.tolist(), dtype=np.int64)
        self.sizes = np.array(module.ngram_heads_vocab_sizes.tolist(), dtype=np.int64)
        self.offsets = np.array(module.ngram_heads_offsets.tolist(), dtype=np.int64)

    def window(self, history: list[int]) -> list[int]:
        """The module's saved window after `history` (the last context_len raw ids)."""
        tail = history[-self.context_len :]
        return [self.eos] * (self.context_len - len(tail)) + list(tail)

    def __call__(self, window: list[int], tokens: list[int]) -> np.ndarray:
        history = np.array([*window, *tokens], dtype=np.int64)
        length = history.size
        positions = np.arange(length, dtype=np.int64)
        eos_positions = np.where(history == self.eos, positions, -1)
        inclusive = np.maximum.accumulate(eos_positions)
        previous = np.concatenate([[-1], inclusive[:-1]])
        in_segment = positions - (previous + 1)
        shifted = [history]
        for shift in range(1, self.ngram_size):
            source = positions - shift
            gathered = history[np.maximum(source, 0)]
            valid = (in_segment >= shift) & (source >= 0)
            shifted.append(np.where(valid, gathered, self.eos))
        blocks = []
        with np.errstate(over="ignore"):
            for ngram in range(2, self.ngram_size + 1):
                start = (ngram - 2) * self.heads
                mixed = shifted[0] * self.multipliers[0]
                for position in range(1, ngram):
                    mixed = np.bitwise_xor(mixed, shifted[position] * self.multipliers[position])
                sizes = self.sizes[start : start + self.heads]
                offsets = self.offsets[start : start + self.heads]
                blocks.append(mixed[:, None] % sizes[None] + offsets[None])
        return np.concatenate(blocks, axis=-1)[-len(tokens) :]


class PlePrefetcher:
    def __init__(self, lm, workers: int = 64):
        found = external_ple(lm)
        if found is None:
            raise ValueError("the model has no external PLE table")
        module, self.table = found
        self.row_ids = RowIds(module)
        self.pool = ThreadPoolExecutor(workers, thread_name_prefix="ple-read")
        self.dispatcher = ThreadPoolExecutor(1, thread_name_prefix="ple-plan")
        files = {a.filename for _, _, arrays in self.table._shards for a in arrays.values()}
        self.fds = {name: os.open(name, os.O_RDONLY) for name in files}
        self.touch_before_read = False
        self.seconds = 0.0
        self._lock = threading.Lock()
        original = self.table._read_rows

        def read_rows(row_ids):
            if self.touch_before_read:
                self._touch(np.asarray(row_ids, dtype=np.int64))
            return original(row_ids)

        self.table._read_rows = read_rows

    def pages(self, rows: np.ndarray) -> list[tuple[int, int]]:
        jobs: list[tuple[int, int]] = []
        for start, end, arrays in self.table._shards:
            local = rows[(rows >= start) & (rows < end)] - start
            if not local.size:
                continue
            for array in arrays.values():
                offsets = (array.offset + local * array.strides[0]) // PAGE_BYTES * PAGE_BYTES
                fd = self.fds[array.filename]
                jobs.extend((fd, int(offset)) for offset in np.unique(offsets))
        return jobs

    def _touch(self, rows: np.ndarray) -> None:
        import time

        started = time.perf_counter()
        jobs = self.pages(np.unique(rows))
        list(self.pool.map(lambda job: os.pread(job[0], PAGE_BYTES, job[1]), jobs))
        with self._lock:
            self.seconds += time.perf_counter() - started

    def prefetch(self, history: list[int], tokens: list[int]) -> Future:
        """Starts reading the pages the lookup of `tokens` after `history` will need."""
        window = self.row_ids.window(history)
        return self.dispatcher.submit(lambda: self._touch(self.row_ids(window, tokens).reshape(-1)))

    def close(self) -> None:
        self.pool.shutdown(wait=False, cancel_futures=True)
        self.dispatcher.shutdown(wait=False, cancel_futures=True)
        for fd in self.fds.values():
            os.close(fd)
