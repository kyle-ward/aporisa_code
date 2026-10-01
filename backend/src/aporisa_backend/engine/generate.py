"""One generation on the worker's main thread (DEVELOPMENT_PLAN.md 7, 14.5).

render -> context check -> session match (memory, then SSD) -> accepted -> chunked prefill
(2048, split at snapshot points, PLE pages of chunk i+1 read while the GPU runs chunk i) ->
decode with the parser -> finished. Cancel and interrupt flags are checked between prefill
chunks and between decode rounds. Every forward call passes explicit text positions.

Images (B2-6, vision.py): a prefill chunk that covers image tokens is fed embeddings with
the vision tower's features in place of the pads (each image encoded once, when its first
chunk comes) and the plan's M-RoPE positions; decoding continues at offset + the plan's
position shift. Sessions are matched on the plan's key sequence, which tells images apart.

Decoding runs in rounds (B2-2, speculative.py): the bonus token b is sampled, the drafter
proposes up to n tokens, one target forward verifies [b, d1..dn], and the target's own
samples are emitted until one differs from its draft. Without a drafter (or when drafting
is off for a session) a round is a single token, which is plain decoding.
"""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass, field

import mlx.core as mx

from .. import vmstats
from ..protocol.structured import value_violation
from .adapters.qwen38 import CALL_CLOSE, STOP_IDS, Qwen38Adapter, RenderPlan, TokenMap
from .sessions import Session, SessionStore, cache_offset
from .speculative import lookup_match, text_only
from .vision import VISION_IDS, ImageError, decode

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

    def _logprobs(self, logits: mx.array, seen: mx.array | None) -> mx.array:
        logits = logits.astype(mx.float32) + self.mask
        if seen is not None:
            logits = logits - self.presence * seen
        return logits - mx.logsumexp(logits, axis=-1, keepdims=True)

    def __call__(self, logits: mx.array, bias: mx.array | None = None) -> int:
        """One token (and remembers it); `bias` (0 or -inf per row) restricts it to what
        a grammar allows."""
        if bias is not None:
            logits = logits.astype(mx.float32) + bias
        token = int(self.sample(self._logprobs(logits, self.seen)[None])[0].item())
        self.accept([token])
        return token

    def rows(self, logits: mx.array, drafts: list[int]) -> list[int]:
        """A round's tokens in one draw: row j of `logits` ([len(drafts) + 1, vocab]) is
        sampled as if drafts[:j] had been emitted, which is the only case in which row j is
        used (the walk stops at the first sample that differs from its draft). One batched
        top-k / top-p / categorical and one sync instead of one per row (B2 P3.5: ~1.1 ms
        each, ~35 of ~150 ms in a 32-draft lookup round). Does not remember the tokens:
        accept() takes the ones actually emitted."""
        seen = None
        if self.seen is not None:
            count = logits.shape[0]
            extra = mx.zeros((count, self.seen.shape[0]), dtype=mx.float32)
            pairs = [
                (row, draft)
                for index, draft in enumerate(drafts[: count - 1])
                for row in range(index + 1, count)
            ]
            if pairs:
                extra[mx.array([r for r, _ in pairs]), mx.array([d for _, d in pairs])] = 1.0
            seen = mx.minimum(self.seen[None] + extra, 1.0)
        return self.sample(self._logprobs(logits, seen)).tolist()

    def accept(self, tokens: list[int]) -> None:
        if self.seen is not None and tokens:
            self.seen[mx.array(tokens)] = 1.0


@dataclass
class Settings:
    context_window: int
    max_output_tokens: int
    prefill_chunk: int = PREFILL_CHUNK
    # (context length from which it applies, drafts per decode round); 0 drafts: plain decoding
    draft_schedule: tuple[tuple[int, int], ...] = ((0, 0),)
    # (context length from which it applies, most prompt-lookup drafts per round)
    lookup_schedule: tuple[tuple[int, int], ...] = ((0, 0),)
    lookup_min_match: int = 3
    lookup_max_match: int = 8
    lookup_cooldown: int = 2
    lookup_trust_match: int = 6
    # (context length from which it applies, fewest tokens verified via the prefill path)
    verify_prefill_schedule: tuple[tuple[int, int], ...] = ((0, 0),)

    def drafts_at(self, context: int) -> int:
        """MTP drafts for a round starting with `context` tokens in the cache."""
        return _at(self.draft_schedule, context)

    def lookups_at(self, context: int) -> int:
        """Most prompt-lookup drafts for a round starting with `context` tokens cached."""
        return _at(self.lookup_schedule, context)


def _at(schedule: tuple[tuple[int, int], ...], context: int) -> int:
    return next((n for start, n in reversed(schedule) if start <= context), 0)


class Engine:
    def __init__(
        self,
        lm,
        adapter: Qwen38Adapter,
        sessions: SessionStore,
        token_map: TokenMap,
        settings: Settings,
        prefetcher=None,
        drafter=None,
        structured=None,
    ):
        self.lm, self.adapter, self.sessions = lm, adapter, sessions
        self.token_map, self.settings, self.prefetcher = token_map, settings, prefetcher
        self.drafter = drafter
        self.structured = structured  # structured.Structured: constrained decoding
        self.vocab_rows = int(lm.args.vocab_size)
        self.metrics: dict = {}
        self.info: dict = {}
        self.model_ref = None
        self._ple_start = (0, 0.0, 0.0)
        self._vm_start: dict = {}
        self._disk_start = (0, 0)
        self._max_chunk_s = 0.0
        self._vision_s = 0.0
        self._images = (0, 0)  # (images, image tokens) of the current request
        self.vision = None  # vision.VisionEncoder when the model takes images

    # --- model calls ----------------------------------------------------------------------

    def _forward(
        self,
        cache: list,
        tokens: list[int],
        hidden: bool = False,
        positions: mx.array | None = None,
        embeds: mx.array | None = None,
    ):
        """Prefill forward: (logits after the last token, pre-mixer hidden states or None).

        The model returns only the pre-mixer hidden states; the final mixer and lm_head run
        on the last position alone. Projecting the whole chunk would materialize logits for
        every position (2048 x 248,320 in bf16, ~1 GB) only to keep one row, and an MLX slice
        shares its parent's buffer, so the kept row pinned the whole gigabyte for as long as
        the session or a snapshot held it (unaccounted in session_bytes).
        """
        if positions is None:
            positions = text_positions(cache_offset(cache), len(tokens))
        out = self.lm(
            mx.array([tokens], dtype=mx.int32),
            inputs_embeds=embeds,
            cache=cache,
            position_ids=positions,
            return_hidden=True,
            skip_logits=True,
        )
        states = out.hidden_states[0]
        last = self.lm.model.hyper_connection_mixer(states[:, -1:])
        logits = self.lm.lm_head(last)[0, -1]
        return logits, (states if hidden else None)

    def _verify(self, cache: list, tokens: list[int], shift: int = 0):
        """Forward over [bonus, drafts...]: every position's logits and hidden state.

        Short rounds take the model's batch-invariant decode path, the one single-token
        decoding takes. mlx-vlm computes wider blocks there as consecutive pairs, which at
        long context costs ~60 ms per extra token (P2 profile: 16 tokens take 964 ms at
        111K), so wide rounds take the prefill path instead, as a prompt chunk would
        (`verify_prefill_schedule`). Both are the model's own inference paths; they differ
        only in kernel rounding. `shift` places the tokens after a prompt's images (M-RoPE).
        """
        offset = cache_offset(cache)
        ids = mx.array([tokens], dtype=mx.int32)
        positions = text_positions(offset + shift, len(tokens))
        wide = _at(self.settings.verify_prefill_schedule, offset)
        if wide and len(tokens) >= wide:
            out = self.lm(
                ids, cache=cache, position_ids=positions, return_hidden=True, skip_logits=True
            )
            hidden = out.hidden_states[0]
            logits = self.lm.lm_head(self.lm.model.hyper_connection_mixer(hidden))[0]
            return logits, hidden
        out = self.lm._batch_invariant_decode(ids, cache=cache, position_ids=positions)
        return out.logits[0], out.hidden_states[-1]

    def _prefill(
        self,
        session: Session,
        tokens: list[int],
        stops: list[int],
        flags: JobFlags,
        limit: int,
        plan: RenderPlan | None = None,
    ) -> bool:
        """Appends tokens[len(session.tokens):]; snapshots at every offset in `stops`.

        With a plan, the session records its cache keys and image chunks get their
        features and positions. Returns False when interrupted; what was prefilled stays in
        the session for reuse.
        """
        keys = plan.cache_keys if plan is not None else tokens
        features: dict[int, mx.array] = {}  # image index -> vision features, while needed
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
            if prefetch is not None and not self._wait(prefetch, flags):
                return False
            chunk_started = time.monotonic()
            draft = session.draft
            positions, embeds = self._image_inputs(plan, begin, end, features)
            logits, hidden = self._forward(
                session.cache,
                tokens[begin:end],
                hidden=draft is not None,
                positions=positions,
                embeds=embeds,
            )
            if draft is not None:
                self.drafter.observe(draft, tokens[begin:end], hidden, begin)
                self.drafter.flush(draft)
            prefetch = (
                self._prefetch(tokens, *pieces[index + 1]) if index + 1 < len(pieces) else None
            )
            mx.eval(
                logits,
                [entry.state for entry in session.cache],
                draft.arrays() if draft is not None else [],
            )
            # One chunk (PLE lookup + GPU) cannot be interrupted; its duration bounds how
            # fast a cancel is confirmed.
            self._max_chunk_s = max(self._max_chunk_s, time.monotonic() - chunk_started)
            if features:  # drop the features of images now fully in the cache
                done = [i for i in features if plan.images[i][0] + plan.images[i][1].tokens <= end]
                for index in done:
                    del features[index]
            session.extend(keys[begin:end])
            session.logits = logits
            if end in cuts:
                session.snapshot(limit, self.drafter.snapshot(draft) if draft else None)
            mx.clear_cache()
        return True

    def _image_inputs(self, plan: RenderPlan | None, begin: int, end: int, features: dict):
        """(positions, embeddings) for prefill chunk [begin, end): None, None without images.
        An image's features are computed when the first chunk covering it comes."""
        if plan is None or plan.positions is None:
            return None, None
        positions = mx.array(plan.positions[:, begin:end])[:, None, :]
        spans = [
            (index, start, spec)
            for index, (start, spec) in enumerate(plan.images)
            if start < end and start + spec.tokens > begin
        ]
        if not spans:
            return positions, None
        embeds = self.lm.model.embed_tokens(mx.array([plan.tokens[begin:end]], dtype=mx.int32))
        pieces, cursor = [], begin
        for index, start, spec in spans:
            if index not in features:
                encode_started = time.monotonic()
                features[index] = self.vision.encode(spec)
                self._vision_s += time.monotonic() - encode_started
            first, last = max(start, begin), min(start + spec.tokens, end)
            if first > cursor:
                pieces.append(embeds[:, cursor - begin : first - begin])
            pieces.append(features[index][None, first - start : last - start].astype(embeds.dtype))
            cursor = last
        if cursor < end:
            pieces.append(embeds[:, cursor - begin :])
        return positions, mx.concatenate(pieces, axis=1)

    @staticmethod
    def _wait(future, flags: JobFlags) -> bool:
        """Waits for a PLE prefetch while staying responsive: raises Cancelled on a cancel,
        returns False on an interrupt."""
        while True:
            try:
                future.result(timeout=0.1)
                return True
            except FutureTimeout:
                if flags.cancel.is_set():
                    raise Cancelled from None
                if flags.interrupt.is_set():
                    return False

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
        mx.reset_peak_memory()  # peak_memory_bytes is per request
        self._ple_start = self._ple_counters()
        self._vm_start = vmstats.sample()
        self._disk_start = self._disk_counters()
        self._max_chunk_s = 0.0
        self._vision_s = 0.0
        request, job_id = job["request"], job["id"]

        def emit(message: dict) -> None:
            send({"id": job_id, **message})

        try:
            plan = self.adapter.render(request, self.token_map)
        except ImageError as error:
            emit({"type": "rejected", "code": "invalid_image", "param": error.param})
            return
        self._images = (len(plan.images), plan.image_tokens)
        input_tokens = len(plan.tokens)
        if input_tokens + plan.max_output_tokens > self.settings.context_window:
            emit({"type": "rejected", "code": "context_length_exceeded"})
            return
        match = self.sessions.acquire(job.get("session"), plan.cache_keys)
        session = match.session
        try:
            total = input_tokens + plan.max_output_tokens
            self.sessions.make_room(session, total)
            self.sessions.recall(match, plan.cache_keys)
            # Every image still to be prefilled must decode, before the stream starts
            # (protocol 9.1 invalid_image); cached ones decoded when they were first sent.
            for start, spec in plan.images:
                if start + spec.tokens > match.cached:
                    try:
                        decode(spec, self.vision.policy)
                    except ImageError as error:
                        emit({"type": "rejected", "code": "invalid_image", "param": error.param})
                        return
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
            complete = self._prefill(session, plan.tokens, stops, flags, limit, plan)
            prefill_s = time.monotonic() - prefill_started
            usage_base = {"input_tokens": input_tokens, "cached_tokens": match.cached}
            if not complete or request.get("generate") is False:
                self.metrics = self._metrics(match, input_tokens, prefill_s, 0, 0.0, started)
                status, reason = ("completed", None) if complete else ("incomplete", "interrupted")
                emit(self._finished(status, reason, usage_base, 0, 0, self.metrics))
                return
            self._decode(request, plan, session, emit, flags, usage_base, match, prefill_s, started)
        finally:
            self.sessions.done(session)

    def _decode(
        self, request, plan, session, emit, flags, usage_base, match, prefill_s, started
    ) -> None:
        parser = self.adapter.parser(plan)
        # Structured output (protocol 8.4): the answer is decoded under a grammar, one token
        # per round (no drafts); reasoning stays free and keeps its drafts.
        constraint = None
        if self.structured is not None and (plan.text_format is not None or plan.strict_schemas):
            constraint = self.structured.constraint(request)
        active = constraint is not None and not plan.thinking
        invalid = None
        sampler = Sampler(plan, self.vocab_rows, self.adapter.codec.vocab_size)
        generated: list[int] = []
        first_token_s = None
        # per draft source: [drafts verified, drafts accepted, rounds]
        stats = {"mtp": [0, 0, 0], "lookup": [0, 0, 0]}
        cooldown = 0
        decode_started = time.monotonic()
        if self.prefetcher is not None:
            self.prefetcher.touch_before_read = True
        status, reason = "completed", None

        def deliver(message: dict) -> None:
            """Emits a parser message; a finished item under a constraint is checked first
            and, when it breaks its schema, withheld (structured_output_invalid)."""
            nonlocal invalid
            if invalid:
                return
            if constraint is not None and message["type"] == "item_done":
                invalid = _structured_violation(plan, message["item"])
                if invalid:
                    return
            emit(message)

        def draw(logits: mx.array) -> int:
            if not active:
                return sampler(logits)
            token = sampler(logits, constraint.bias())
            constraint.consume(token)
            return token

        def activate() -> bool:
            """True when this token closed the reasoning and the answer is constrained."""
            nonlocal active
            if constraint is None or active or parser.state == "reasoning":
                return False
            active = True
            return True

        def take(token: int) -> bool:
            """Emits one sampled token; True when generation ends with it."""
            nonlocal first_token_s, status, reason
            generated.append(token)
            if first_token_s is None:
                first_token_s = time.monotonic() - started
            if token in STOP_IDS:
                for message in parser.finish():
                    deliver(message)
                return True
            for message in parser.feed(token):
                deliver(message)
            if parser.failed or invalid:
                return True
            if plan.stop_after_call and token == CALL_CLOSE:
                for message in parser.finish():
                    deliver(message)
                return True
            if len(generated) >= plan.max_output_tokens:
                status, reason = "incomplete", "max_output_tokens"
                return True
            return False

        draft = session.draft
        try:
            token = draw(session.logits)
            done = take(token)
            activate()
            while not done:
                if flags.cancel.is_set():
                    raise Cancelled
                if flags.interrupt.is_set():
                    status, reason = "incomplete", "interrupted"
                    break
                # [token, drafts...] never runs past max_output_tokens: the last position
                # verified is the last one that could still be emitted.
                room = plan.max_output_tokens - len(generated) - 1
                drafts, source = (
                    ([], None) if active else self._drafts(session, token, room, cooldown)
                )
                inputs = [token, *drafts]
                transaction = None
                if drafts:
                    from mlx_vlm.speculative.cache_state import start_speculative_cache

                    transaction = start_speculative_cache(session.cache, len(inputs))
                try:
                    logits, hidden = self._verify(session.cache, inputs, plan.position_shift)
                    mx.eval(logits)
                    constrained = active
                    choices = [draw(logits[0])] if constrained else sampler.rows(logits, drafts)
                    keep, emitted = 0, []
                    for sampled in choices:
                        emitted.append(sampled)
                        done = take(sampled)
                        keep += 1
                        # A token that opens the constrained answer ends the round: later
                        # positions were sampled without the grammar's mask.
                        switched = activate()
                        if done or switched or keep > len(drafts) or sampled != drafts[keep - 1]:
                            break
                    if not constrained:
                        sampler.accept(emitted)
                    if transaction is not None:
                        transaction.commit(keep)
                except BaseException:
                    if transaction is not None:
                        transaction.abort()
                    raise
                if source is not None:
                    stats[source][0] += len(drafts)
                    stats[source][1] += keep - 1
                    stats[source][2] += 1
                if source == "lookup" and keep == 1:
                    cooldown = self.settings.lookup_cooldown
                elif cooldown:
                    cooldown -= 1
                session.extend(inputs[:keep])
                session.logits = logits[keep - 1]
                if draft is not None:
                    self.drafter.observe(
                        draft, inputs[:keep], hidden[:, :keep], len(session.tokens) - keep
                    )
                token = sampled
        finally:
            if self.prefetcher is not None:
                self.prefetcher.touch_before_read = False
        if draft is not None:
            self.drafter.flush(draft)
            mx.eval(draft.arrays())
        decode_s = time.monotonic() - decode_started
        self.metrics = self._metrics(
            match, usage_base["input_tokens"], prefill_s, len(generated), decode_s, started
        )
        self.metrics["first_token_ms"] = round(first_token_s * 1000) if first_token_s else None
        for source, (count, kept, rounds) in stats.items():
            if count:
                self.metrics[f"{source}_accept_rate"] = round(kept / count, 3)
            if source == "lookup" and rounds:
                self.metrics["lookup_rounds"] = rounds
        if parser.failed:
            emit({"type": "failed", "code": "tool_call_invalid", "detail": parser.failed})
            return
        if invalid:
            emit({"type": "failed", "code": "structured_output_invalid"})
            return
        if status == "completed":
            self.adapter.record(self.token_map, plan, parser.items, generated)
        reasoning = parser.reasoning_tokens if plan.thinking else 0
        emit(self._finished(status, reason, usage_base, len(generated), reasoning, self.metrics))

    def _drafts(self, session, token: int, room: int, cooldown: int):
        """(drafts, source) for the next round: a prompt-lookup copy when the context's tail
        recurs (and lookup is not cooling down after a miss), else MTP drafts, else none.

        A long match is a copy in progress and is trusted. A short one also happens in
        ordinary text, where its drafts were rarely accepted (P3.5 validation: 13 lookup
        rounds at 0.16 in a 384-token answer, ~6% slower than MTP alone), so it is used only
        when the MTP head predicts the same next token."""
        context = len(session.tokens)
        settings = self.settings
        count = min(settings.drafts_at(context), room)
        mtp = session.draft is not None and count > 0
        lookups = min(settings.lookups_at(context), room)
        if lookups > 0 and not cooldown:
            drafts, matched = lookup_match(
                session.token_array(),
                token,
                lookups,
                settings.lookup_min_match,
                settings.lookup_max_match,
            )
            drafts = text_only(drafts, VISION_IDS)
            if drafts and (matched >= settings.lookup_trust_match or not mtp):
                return drafts, "lookup"
            if drafts:
                predicted = self.drafter.propose(session.draft, token, count)
                if predicted[:1] == drafts[:1]:
                    return drafts, "lookup"  # the drafter's pairs stay consistent (observe)
                return predicted, "mtp"
        if mtp:
            return self.drafter.propose(session.draft, token, count), "mtp"
        return [], None

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

    def _ple_counters(self) -> tuple[int, float, float]:
        """(bytes gathered from the external table, main-thread lookup s, prefetch thread s)."""
        if self.prefetcher is None:
            return (0, 0.0, 0.0)
        stats = self.prefetcher.table.stats
        return (stats.bytes_read, stats.elapsed_seconds, self.prefetcher.seconds)

    def _disk_counters(self) -> tuple[int, int]:
        """(sessions spilled, bytes written) by the SSD cache so far."""
        disk = self.sessions.disk
        return (disk.stats.spills, disk.stats.written_bytes) if disk is not None else (0, 0)

    def _metrics(self, match, input_tokens, prefill_s, output_tokens, decode_s, started) -> dict:
        prefilled = input_tokens - match.cached
        session = match.session
        ple = [now - then for now, then in zip(self._ple_counters(), self._ple_start, strict=True)]
        spills, written = (
            now - then for now, then in zip(self._disk_counters(), self._disk_start, strict=True)
        )
        disk = self.sessions.disk is not None
        return {
            "ple_bytes_read": int(ple[0]) if self.prefetcher is not None else None,
            "ple_lookup_ms": round(ple[1] * 1000) if self.prefetcher is not None else None,
            "ple_prefetch_ms": round(ple[2] * 1000) if self.prefetcher is not None else None,
            **vmstats.delta(self._vm_start, vmstats.sample()),
            "prefill_max_chunk_ms": round(self._max_chunk_s * 1000),
            "snapshot_count": len(session.snapshots),
            "snapshot_bytes": sum(s.nbytes for s in session.snapshots),
            "session_bytes": session.nbytes(),
            "restore_path": match.path,
            "image_count": self._images[0] or None,
            "image_tokens": self._images[1] or None,
            "vision_encode_ms": round(self._vision_s * 1000) if self._images[0] else None,
            "ssd_load_ms": match.load_ms,
            "ssd_spill_count": spills if disk else None,
            "ssd_bytes_written": written if disk else None,
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


def _structured_violation(plan: RenderPlan, item: dict) -> str | None:
    """The final check of protocol 8.4 for one finished item (None when it conforms)."""
    if item["type"] == "message" and plan.text_format is not None:
        text = "".join(part["text"] for part in item["content"])
        try:
            value = json.loads(text)
        except ValueError:
            return "the answer is not JSON"
        return value_violation(value, plan.text_format)
    if item["type"] == "function_call" and item["name"] in plan.strict_schemas:
        return value_violation(json.loads(item["arguments"]), plan.strict_schemas[item["name"]])
    return None
