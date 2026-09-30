"""One generation on the worker's main thread (DEVELOPMENT_PLAN.md 7, 14.5).

render -> context check -> session match -> accepted -> chunked prefill (2048, split at
snapshot points, PLE pages of chunk i+1 read while the GPU runs chunk i) -> decode with the
parser -> finished. Cancel and interrupt flags are checked between prefill chunks and
between decoded tokens. Every forward call passes explicit text positions.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field

import mlx.core as mx

from .adapters.qwen38 import CALL_CLOSE, STOP_IDS, Qwen38Adapter, RenderPlan, TokenMap
from .sessions import Session, SessionStore, cache_offset

PREFILL_CHUNK = 2048

Send = Callable[[dict], None]


@dataclass
class JobFlags:
    """Set by the control thread, read by the main thread between steps."""

    interrupt: threading.Event = field(default_factory=threading.Event)
    cancel: threading.Event = field(default_factory=threading.Event)


class Cancelled(Exception):
    pass


def text_positions(offset: int, length: int) -> mx.array:
    """Text-only M-RoPE positions: all three sections offset..offset+length-1."""
    row = mx.arange(offset, offset + length, dtype=mx.int32)[None, None, :]
    return mx.broadcast_to(row, (3, 1, length))


class Sampler:
    """Model-card sampling: temperature / top-p / top-k over log-probs, presence penalty
    over the tokens generated so far (OpenAI semantics), banned ids and padded vocab rows
    masked out."""

    def __init__(self, plan: RenderPlan, vocab_rows: int, tokenizer_vocab: int):
        from mlx_vlm.sample_utils import make_sampler

        s = plan.sampling
        self.sample = make_sampler(temp=s.temperature, top_p=s.top_p, min_p=s.min_p, top_k=s.top_k)
        self.presence = s.presence_penalty
        mask = mx.zeros((vocab_rows,), dtype=mx.float32)
        banned = [t for t in plan.banned_ids if t < vocab_rows]
        if banned:
            mask[mx.array(banned)] = -mx.inf
        if tokenizer_vocab < vocab_rows:
            mask[tokenizer_vocab:] = -mx.inf
        self.mask = mask
        self.seen = mx.zeros((vocab_rows,), dtype=mx.float32) if self.presence else None

    def __call__(self, logits: mx.array) -> int:
        logits = logits.astype(mx.float32) + self.mask
        if self.seen is not None:
            logits = logits - self.presence * self.seen
        logprobs = logits - mx.logsumexp(logits, axis=-1, keepdims=True)
        token = int(self.sample(logprobs[None])[0].item())
        if self.seen is not None:
            self.seen[token] = 1.0
        return token


@dataclass
class Settings:
    context_window: int
    max_output_tokens: int
    prefill_chunk: int = PREFILL_CHUNK


class Engine:
    def __init__(
        self,
        lm,
        adapter: Qwen38Adapter,
        sessions: SessionStore,
        token_map: TokenMap,
        settings: Settings,
        prefetcher=None,
    ):
        self.lm, self.adapter, self.sessions = lm, adapter, sessions
        self.token_map, self.settings, self.prefetcher = token_map, settings, prefetcher
        self.vocab_rows = int(lm.args.vocab_size)
        self.metrics: dict = {}
        self.info: dict = {}
        self.model_ref = None

    # --- model calls ----------------------------------------------------------------------

    def _forward(self, cache: list, tokens: list[int]) -> mx.array:
        offset = cache_offset(cache)
        out = self.lm(
            mx.array([tokens], dtype=mx.int32),
            cache=cache,
            position_ids=text_positions(offset, len(tokens)),
            logits_to_keep=1,
        )
        return out.logits[0, -1]

    def _prefill(
        self, session: Session, tokens: list[int], stops: list[int], flags: JobFlags, limit: int
    ) -> bool:
        """Appends tokens[len(session.tokens):]; snapshots at every offset in `stops`.

        Returns False when interrupted; what was prefilled stays in the session for reuse.
        """
        start = len(session.tokens)
        cuts = sorted({s for s in stops if start < s <= len(tokens)} | {len(tokens)})
        pieces: list[tuple[int, int]] = []
        begin = start
        for cut in cuts:
            while begin < cut:
                end = min(begin + self.settings.prefill_chunk, cut)
                pieces.append((begin, end))
                begin = end
        prefetch = self._prefetch(tokens, *pieces[0]) if pieces else None
        for index, (begin, end) in enumerate(pieces):
            if flags.cancel.is_set():
                raise Cancelled
            if flags.interrupt.is_set():
                return False
            if prefetch is not None:
                prefetch.result()
            logits = self._forward(session.cache, tokens[begin:end])
            prefetch = (
                self._prefetch(tokens, *pieces[index + 1]) if index + 1 < len(pieces) else None
            )
            mx.eval(logits, [entry.state for entry in session.cache])
            session.tokens.extend(tokens[begin:end])
            session.logits = logits
            if end in cuts:
                session.snapshot(limit)
            mx.clear_cache()
        return True

    def _prefetch(self, tokens: list[int], begin: int, end: int):
        if self.prefetcher is None:
            return None
        return self.prefetcher.prefetch(tokens[:begin], tokens[begin:end])

    # --- requests -------------------------------------------------------------------------

    def count(self, request: dict, adapter: Qwen38Adapter | None = None) -> int:
        return len((adapter or self.adapter).render(request, self.token_map).tokens)

    def generate(self, job: dict, send: Send, flags: JobFlags) -> None:
        """Runs one job, sending worker messages. Raises Cancelled after a hard cancel."""
        started = time.monotonic()
        request, job_id = job["request"], job["id"]

        def emit(message: dict) -> None:
            send({"id": job_id, **message})

        plan = self.adapter.render(request, self.token_map)
        input_tokens = len(plan.tokens)
        if input_tokens + plan.max_output_tokens > self.settings.context_window:
            emit({"type": "rejected", "code": "context_length_exceeded"})
            return
        match = self.sessions.acquire(job.get("session"), plan.tokens)
        session = match.session
        try:
            total = input_tokens + plan.max_output_tokens
            self.sessions.make_room(session, total)
            emit(
                {
                    "type": "accepted",
                    "input_tokens": input_tokens,
                    "cached_tokens": match.cached,
                    "restore_path": match.path,
                }
            )
            limit = self.sessions.snapshot_limit(session, total)
            # Snapshot points: the latest item boundaries of the newly prefilled region, and
            # the prompt end (where the next continuation or retry diverges).
            fresh = [b for b in plan.boundaries if b > match.cached]
            stops = fresh[-(self.sessions.max_snapshots - 1) :] if fresh else []
            prefill_started = time.monotonic()
            complete = self._prefill(session, plan.tokens, stops, flags, limit)
            prefill_s = time.monotonic() - prefill_started
            usage_base = {"input_tokens": input_tokens, "cached_tokens": match.cached}
            if not complete or request.get("generate") is False:
                self.metrics = self._metrics(match, input_tokens, prefill_s, 0, 0.0, started)
                status, reason = ("completed", None) if complete else ("incomplete", "interrupted")
                emit(self._finished(status, reason, usage_base, 0, 0, self.metrics))
                return
            self._decode(plan, session, emit, flags, usage_base, match, prefill_s, started)
        finally:
            self.sessions.done(session)

    def _decode(self, plan, session, emit, flags, usage_base, match, prefill_s, started) -> None:
        parser = self.adapter.parser(plan)
        sampler = Sampler(plan, self.vocab_rows, self.adapter.codec.vocab_size)
        logits = session.logits
        generated: list[int] = []
        first_token_s = None
        decode_started = time.monotonic()
        if self.prefetcher is not None:
            self.prefetcher.touch_before_read = True
        status, reason = "completed", None
        try:
            while True:
                if flags.cancel.is_set():
                    raise Cancelled
                if flags.interrupt.is_set():
                    status, reason = "incomplete", "interrupted"
                    break
                token = sampler(logits)
                generated.append(token)
                if first_token_s is None:
                    first_token_s = time.monotonic() - started
                if token in STOP_IDS:
                    for message in parser.finish():
                        emit(message)
                    break
                for message in parser.feed(token):
                    emit(message)
                if parser.failed:
                    break
                if plan.stop_after_call and token == CALL_CLOSE:
                    for message in parser.finish():
                        emit(message)
                    break
                if len(generated) >= plan.max_output_tokens:
                    status, reason = "incomplete", "max_output_tokens"
                    break
                logits = self._forward(session.cache, [token])
                mx.eval(logits)
                session.tokens.append(token)
                session.logits = logits
        finally:
            if self.prefetcher is not None:
                self.prefetcher.touch_before_read = False
        decode_s = time.monotonic() - decode_started
        self.metrics = self._metrics(
            match, usage_base["input_tokens"], prefill_s, len(generated), decode_s, started
        )
        self.metrics["first_token_ms"] = round(first_token_s * 1000) if first_token_s else None
        if parser.failed:
            emit({"type": "failed", "code": "tool_call_invalid", "detail": parser.failed})
            return
        if status == "completed":
            self.adapter.record(self.token_map, plan, parser.items, generated)
        reasoning = parser.reasoning_tokens if plan.thinking else 0
        emit(self._finished(status, reason, usage_base, len(generated), reasoning, self.metrics))

    @staticmethod
    def _finished(status, reason, base, output_tokens, reasoning_tokens, metrics) -> dict:
        message = {
            "type": "finished",
            "status": status,
            "metrics": metrics,
            "usage": {
                "input_tokens": base["input_tokens"],
                "input_tokens_details": {"cached_tokens": base["cached_tokens"]},
                "output_tokens": output_tokens,
                "output_tokens_details": {"reasoning_tokens": reasoning_tokens},
                "total_tokens": base["input_tokens"] + output_tokens,
            },
        }
        if reason:
            message["reason"] = reason
        return message

    def _metrics(self, match, input_tokens, prefill_s, output_tokens, decode_s, started) -> dict:
        prefilled = input_tokens - match.cached
        return {
            "restore_path": match.path,
            "prefill_tokens": prefilled,
            "prefill_tok_s": round(prefilled / prefill_s, 1)
            if prefill_s > 0 and prefilled
            else None,
            "decode_tok_s": round(output_tokens / decode_s, 1)
            if decode_s > 0 and output_tokens
            else None,
            "duration_ms": round((time.monotonic() - started) * 1000),
            "peak_memory_bytes": mx.get_peak_memory(),
        }
