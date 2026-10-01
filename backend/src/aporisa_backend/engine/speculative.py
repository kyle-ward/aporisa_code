"""Speculative decoding, the draft side: the MTP head (B2-2) and prompt lookup (B2-3).

The model's native MTP head is a one-layer model that predicts the token after next from
(embedding of token t+1, target hidden state at t). It keeps its own small KV cache, one
entry per such pair, at position t. For a session holding T target tokens the drafter has
consumed the pairs for positions 0..T-2 and keeps the target hidden state at T-1; the pair
for position T-1 needs token T, which is only known once it is sampled.

A decode round (generate.py) samples the bonus token b, asks for n drafts, verifies
[b, d1..dn] in one target forward and keeps the longest prefix whose tokens the target
sampled itself. Every emitted token is a target sample, drawn with the request's sampler
exactly once per position, so the output is the one plain decoding produces (same tokens
for the same random state); drafts only decide how many positions one forward covers.
Drafts are the drafter's argmax: with a deterministic draft, "accept when the target sample
equals it" is the same rule as speculative rejection sampling.

Drafter state is an accelerator like the rest of the session: pairs fed during a round for
drafted tokens use the drafter's own hidden states and are trimmed afterwards; the pairs
for accepted tokens are fed again with the target's hidden states.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import mlx.core as mx
import numpy as np


def lookup_drafts(
    history: np.ndarray, bonus: int, count: int, min_match: int, max_match: int
) -> list[int]:
    return lookup_match(history, bonus, count, min_match, max_match)[0]


def lookup_match(
    history: np.ndarray, bonus: int, count: int, min_match: int, max_match: int
) -> tuple[list[int], int]:
    """Prompt lookup (B2-3): drafts copied from the context, and how many tokens matched.

    The context is `history` (the tokens in the cache) followed by `bonus` (sampled, not
    yet in the cache). Finds the earlier position whose preceding tokens match the context's
    tail longest (at least `min_match`, at most `max_match` tokens; the most recent among
    equals) and returns the tokens that followed it. Editing and quoting code repeat long
    spans of files already in the context, which the target then accepts in a single verify.

    How many: 2 for a match of `min_match` tokens, doubling with each further matched token,
    at most `count`. Ordinary text repeats short phrases too; such false hits matched 3-4
    tokens and were almost never accepted (P2 validation: 0-9%), yet each one verified up to
    32 tokens instead of an MTP round. A real copy reaches the longest match within a few
    tokens, so it still drafts `count` per round. Vectorized over the whole context: well
    under a millisecond at 262K.
    """
    size = history.size
    if count <= 0 or size + 1 < min_match:
        return [], 0
    ends = np.flatnonzero(history == bonus)  # candidate windows end here, like the tail
    if ends.size == 0:
        return [], 0
    length = np.ones(ends.size, dtype=np.int32)
    alive = np.ones(ends.size, dtype=bool)
    for back in range(1, max_match):
        if back > size:
            break
        index = ends - back
        alive &= (index >= 0) & (history[np.maximum(index, 0)] == history[size - back])
        if not alive.any():
            break
        length += alive
    best = int(length.max())
    if best < min_match:
        return [], 0
    end = int(ends[np.flatnonzero(length == best)[-1]])
    count = min(count, 2 ** (best - min_match + 1))
    follow = history[end + 1 : end + 1 + count].tolist()
    if len(follow) < count and end + 1 + len(follow) == size:
        follow.append(bonus)  # the window ends right before the tail: it repeats itself
    return [int(t) for t in follow], best


def text_only(drafts: list[int], vision_ids: frozenset[int]) -> list[int]:
    """Lookup drafts up to the first image token: a copy that runs into an image would draft
    its key (negative, never a model id) or its pads (input only)."""
    for index, draft in enumerate(drafts):
        if draft < 0 or draft in vision_ids:
            return drafts[:index]
    return drafts


@dataclass
class DraftState:
    cache: list
    hidden: mx.array | None = None  # target hidden state after the last target token
    appended: int = 0  # drafter pairs fed for drafted tokens this round (to trim)
    first_fed: bool = False  # the next observed token's pair was fed by propose()
    pending: list[tuple[list[int], mx.array]] = field(default_factory=list)

    def offset(self) -> int:
        return int(self.cache[0].offset or 0) if self.cache else 0

    def nbytes(self) -> int:
        total = sum(int(getattr(entry, "nbytes", 0) or 0) for entry in self.cache)
        return total + (self.hidden.nbytes if self.hidden is not None else 0)

    def arrays(self) -> list:
        values = [entry.state for entry in self.cache]
        return values + ([self.hidden] if self.hidden is not None else [])


class MtpDrafter:
    """Drives the mlx-vlm Qwen4-Exp MTP draft model bound to the target (runtime.load)."""

    def __init__(self, draft_model):
        self.model = draft_model

    def new_state(self) -> DraftState:
        return DraftState(self.model.make_cache())

    def _feed(self, state: DraftState, tokens: list[int], hidden: mx.array):
        """Feeds pairs (tokens[i], hidden[:, i]); returns the last (logit, pre-mixer) hidden."""
        model = self.model
        model._next_position = state.offset()
        ids = mx.array([tokens], dtype=mx.int32)
        logits_hidden, hidden_out = model._forward_hidden(
            model._input_embed(ids), hidden, ids, state.cache
        )
        return logits_hidden[:, -1:], hidden_out[:, -1:]

    def observe(self, state: DraftState, tokens: list[int], hidden: mx.array, start: int) -> None:
        """The target consumed `tokens` at positions start.. and produced `hidden`
        ([1, len(tokens), W]). Queues the pairs this makes complete: token i pairs with the
        hidden state at the position before it."""
        if not tokens:
            return
        if state.appended:
            for entry in state.cache:
                entry.trim(state.appended)
            state.appended = 0
        if state.first_fed:
            pairs, previous = tokens[1:], hidden[:, :-1]
        elif start > 0 and state.hidden is not None:
            pairs = tokens
            previous = mx.concatenate([state.hidden, hidden[:, :-1]], axis=1)
        else:
            pairs, previous = tokens[1:], hidden[:, :-1]
        state.first_fed = False
        if pairs:
            state.pending.append((pairs, previous))
        # A copy: a slice would share (and keep alive) the whole chunk's hidden states,
        # 2048 x 10240 bf16 per session and per snapshot that holds this row.
        state.hidden = mx.contiguous(hidden[:, -1:])

    def flush(self, state: DraftState) -> None:
        """Feeds the queued pairs (before a snapshot, at the end of a request)."""
        if state.pending:
            tokens = [t for chunk, _ in state.pending for t in chunk]
            hidden = mx.concatenate([h for _, h in state.pending], axis=1)
            state.pending = []
            self._feed(state, tokens, hidden)

    def propose(self, state: DraftState, bonus: int, count: int) -> list[int]:
        """Up to `count` greedy drafts following `bonus` (sampled, not yet in the target)."""
        if count <= 0 or state.hidden is None:
            return []
        tokens = [t for chunk, _ in state.pending for t in chunk] + [bonus]
        hidden = mx.concatenate([h for _, h in state.pending] + [state.hidden], axis=1)
        state.pending = []
        logits_hidden, hidden_out = self._feed(state, tokens, hidden)
        state.first_fed = True
        head = self.model._lm_head_fn
        drafts = [int(mx.argmax(head(logits_hidden)[0, -1]).item())]
        while len(drafts) < count:
            logits_hidden, hidden_out = self._feed(state, drafts[-1:], hidden_out)
            state.appended += 1
            drafts.append(int(mx.argmax(head(logits_hidden)[0, -1]).item()))
        return drafts

    @staticmethod
    def snapshot(state: DraftState) -> mx.array | None:
        return state.hidden

    def restore(self, state: DraftState, hidden: mx.array | None, offset: int) -> bool:
        """Rewinds to a target snapshot at `offset`; False when the drafter cannot follow."""
        self.flush(state)
        excess = state.offset() - (offset - 1)
        if hidden is None or offset < 1 or excess < 0 or state.appended:
            return False
        if excess:
            for entry in state.cache:
                entry.trim(excess)
        state.hidden, state.first_fed = hidden, False
        return True
