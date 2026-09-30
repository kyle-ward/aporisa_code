"""MTP speculative decoding on the tiny model (B2-2).

Every emitted token is a target sample at its position; drafts only decide how many
positions one forward verifies. The output is therefore the target model's, but not always
bit-equal to one-token-at-a-time decoding: verifying several tokens runs multi-query
attention kernels whose float rounding differs from the single-query ones, and a near tie
in MoE routing or sparse-block selection occasionally flips (P1 sweep on the tiny model:
6 of 110 random 9-token continuations differed somewhere). The equality tests below are
deterministic on the tiny model and pin its behaviour; the sampled-mode test checks the
structural properties instead.

The tiny drafter is random, so its drafts are almost always rejected; the acceptance path is
exercised by substituting drafts taken from a plain run (some deliberately wrong) while the
real drafter still runs and keeps its state.
"""

from __future__ import annotations

import mlx.core as mx
import numpy as np
import pytest
from conftest import ALIAS, request, user, worker_init

from aporisa_backend.engine import generate as gen
from aporisa_backend.engine.sessions import cache_offset
from aporisa_backend.engine.speculative import MtpDrafter

DRAFTS = 2


@pytest.fixture(scope="module")
def engine(tiny_model_dir, tiny_draft_dir):
    from aporisa_backend.engine import runtime

    engine = runtime.load(
        worker_init(tiny_model_dir, draft_dir=str(tiny_draft_dir), draft_schedule=[[0, DRAFTS]])
    )
    runtime.warmup(engine, ALIAS)  # fails unless drafts were verified
    return engine


def run(engine, body, session=None, drafts=DRAFTS, seed=7, lookups=0):
    """Messages without metrics, plus the metrics; sampling starts from a fixed seed.
    Prompt lookup is off unless `lookups` asks for it."""
    engine.settings.draft_schedule = ((0, drafts),)
    engine.settings.lookup_schedule = ((0, lookups),)
    mx.random.seed(seed)
    messages: list[dict] = []
    try:
        engine.generate(
            {"id": "t", "request": body, "session": session}, messages.append, gen.JobFlags()
        )
    finally:
        engine.settings.draft_schedule = ((0, DRAFTS),)
        engine.settings.lookup_schedule = ((0, 0),)
    metrics = messages[-1].get("metrics", {})
    return [{k: v for k, v in m.items() if k != "metrics"} for m in messages], metrics


@pytest.fixture
def recorded(monkeypatch):
    """Records every token the request's sampler draws."""
    tokens: list[int] = []
    inner = gen.Sampler.__call__

    def record(self, logits):
        token = inner(self, logits)
        tokens.append(token)
        return token

    monkeypatch.setattr(gen.Sampler, "__call__", record)
    return tokens


BODIES = [
    request("Tell me a story.", max_output_tokens=48, reasoning={"effort": "medium"}),
    request("Short answer.", max_output_tokens=24, reasoning={"effort": "none"}),
]


@pytest.mark.parametrize("body", BODIES)
def test_same_output_as_plain_decoding(engine, body):
    plain, plain_metrics = run(engine, body, drafts=0)
    speculative, metrics = run(engine, body)
    assert speculative == plain
    assert "mtp_accept_rate" in metrics and plain_metrics.get("mtp_accept_rate") is None


def substitute(monkeypatch, recorded, reference, wrong_every=0):
    """Drafts become the reference's next tokens (every `wrong_every`-th one wrong)."""
    real = MtpDrafter.propose
    counter = {"n": 0}

    def propose(self, state, bonus, count):
        drafts = real(self, state, bonus, count)  # keeps the drafter's bookkeeping
        position = len(recorded)  # the bonus is recorded[-1]; drafts follow it
        substituted = []
        for index in range(len(drafts)):
            counter["n"] += 1
            wanted = reference[min(position + index, len(reference) - 1)]
            wrong = wrong_every and counter["n"] % wrong_every == 0
            substituted.append(wanted + 1 if wrong else wanted)
        return substituted

    monkeypatch.setattr(MtpDrafter, "propose", propose)


@pytest.fixture
def greedy(monkeypatch):
    def argmax(self, logits):
        return int(mx.argmax(logits.astype(mx.float32) + self.mask).item())

    monkeypatch.setattr(gen.Sampler, "__call__", argmax)


@pytest.mark.parametrize("wrong_every", [0, 3])
def test_greedy_accepted_drafts_keep_the_output(engine, greedy, recorded, monkeypatch, wrong_every):
    body = request("Accept my drafts.", max_output_tokens=40, reasoning={"effort": "medium"})
    plain, _ = run(engine, body, drafts=0)
    reference = list(recorded)
    recorded.clear()
    substitute(monkeypatch, recorded, reference, wrong_every)
    speculative, metrics = run(engine, body)
    assert speculative == plain and recorded == reference
    assert metrics["mtp_accept_rate"] > (0.9 if wrong_every == 0 else 0.3)


def test_sampled_rounds_emit_only_target_samples(engine, recorded, monkeypatch):
    body = request("Sample with drafts.", max_output_tokens=40, reasoning={"effort": "medium"})
    run(engine, body, drafts=0)
    reference = list(recorded)
    recorded.clear()
    substitute(monkeypatch, recorded, reference, wrong_every=3)
    messages, metrics = run(engine, body)
    finished = messages[-1]
    # One sampler draw per emitted token, drafts or not: drafts are never emitted unsampled.
    assert finished["usage"]["output_tokens"] == len(recorded)
    assert metrics["mtp_accept_rate"] > 0.3


def test_output_limit_and_drafter_state_across_requests(engine, greedy, recorded, monkeypatch):
    body = request("Keep going.", max_output_tokens=7, reasoning={"effort": "none"})
    plain, _ = run(engine, body, drafts=0)
    reference = list(recorded)
    recorded.clear()
    substitute(monkeypatch, recorded, reference)
    messages, _ = run(engine, body, session="spec")
    assert messages == plain
    assert messages[-1]["usage"]["output_tokens"] == 7
    session = engine.sessions.sessions["spec"]
    # At rest the drafter holds the pairs for positions 0..T-2 and the hidden state at T-1.
    assert session.draft.offset() == len(session.tokens) - 1
    assert session.token_array().tolist() == session.tokens
    assert session.draft.pending == [] and session.draft.appended == 0

    retry, metrics = run(engine, body, session="spec")
    assert retry[0]["restore_path"] == "snapshot" and session.draft is not None
    assert session.draft.offset() == len(session.tokens) - 1
    assert metrics["mtp_accept_rate"] is not None

    # A continuation after a restore: the drafter follows the target from the snapshot.
    follow = {**body, "input": [*body["input"], user("and more")]}
    run(engine, follow, session="spec")
    assert session.draft.offset() == len(session.tokens) - 1
    assert session.token_array().tolist() == session.tokens  # through restore and extend
    engine.sessions.release("spec")


def test_snapshot_without_drafter_state_disables_drafting(engine, greedy):
    body = request("Drop the drafter.", max_output_tokens=6, reasoning={"effort": "none"})
    run(engine, body, session="nodraft")
    session = engine.sessions.sessions["nodraft"]
    for snap in session.snapshots:
        snap.draft = None
    retry, metrics = run(engine, body, session="nodraft")
    assert retry[0]["restore_path"] == "snapshot"
    assert session.draft is None and metrics.get("mtp_accept_rate") is None
    plain, _ = run(engine, body, drafts=0)

    def content(messages):
        return [m for m in messages if m["type"] not in ("accepted", "finished")]

    assert content(retry) == content(plain)
    assert retry[-1]["usage"]["output_tokens"] == plain[-1]["usage"]["output_tokens"]
    engine.sessions.release("nodraft")


def test_drafter_session_memory_is_what_session_bytes_reports(engine):
    """The drafter's kept hidden row (in the session and in snapshots) is its own copy."""
    import gc

    def active():
        gc.collect()
        mx.synchronize()
        mx.clear_cache()
        return mx.get_active_memory()

    tokens = [(i * 7919) % 200_000 + 1000 for i in range(2048)]
    before = active()
    match = engine.sessions.acquire("pinned-draft", tokens)
    engine._prefill(match.session, tokens, [512, 1024, 1536], gen.JobFlags(), 16)
    engine.sessions.done(match.session)
    reported = match.session.nbytes()
    held = active() - before
    engine.sessions.release("pinned-draft")
    assert abs(held - reported) < 1024**2, (held, reported)


def test_draft_schedule_follows_context_length():
    settings = gen.Settings(context_window=1000, max_output_tokens=10)
    assert settings.drafts_at(500) == 0
    settings.draft_schedule = ((0, 2), (32_768, 1))
    assert [settings.drafts_at(n) for n in (0, 32_767, 32_768, 200_000)] == [2, 2, 1, 1]


# --- prompt lookup (B2-3) ---------------------------------------------------------------------


def test_lookup_prefers_the_longest_then_the_latest_match():
    from aporisa_backend.engine.speculative import lookup_drafts

    def drafts(history, bonus, count=4, low=3, high=8):
        return lookup_drafts(np.array(history, dtype=np.int32), bonus, count, low, high)

    # tail (.., 2, 3) + bonus 4: "2 3 4" occurs twice; the later one wins
    assert drafts([2, 3, 4, 10, 11, 2, 3, 4, 20, 21, 22, 2, 3], 4) == [20, 21]
    # a longer match (1 2 3 4) beats a later shorter one (2 3 4), and drafts more
    assert drafts([1, 2, 3, 4, 30, 9, 8, 7, 2, 3, 4, 40, 1, 2, 3], 4) == [30, 9, 8, 7]
    assert drafts([7, 8, 9, 5, 7, 8], 9, count=1) == [5]  # capped by count
    assert drafts([7, 8, 9, 5, 1, 8], 9) == []  # tail "1 8 9" never occurred
    assert drafts([7, 8, 9, 5, 1, 8], 9, low=2) == [5, 1]  # "8 9" is enough at 2
    assert drafts([], 9) == [] and drafts([7, 8, 9], 9, count=0) == []


def test_lookup_drafts_more_the_longer_the_match():
    from aporisa_backend.engine.speculative import lookup_drafts

    span = list(range(100, 140))
    for matched, expected in ((3, 2), (4, 4), (5, 8), (6, 16), (7, 32), (8, 32)):
        # the context ends with span[:matched]: the bonus is span[matched - 1]
        context = np.array([*span, 1, 2, *span[: matched - 1]], dtype=np.int32)
        got = lookup_drafts(context, span[matched - 1], 32, 3, 8)
        assert got == span[matched : matched + expected], matched


@pytest.fixture
def script(monkeypatch, engine):
    """script(text): generations sample exactly these tokens (whatever the logits say)."""

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


PASSAGE = (
    "def resolve(layout, identity):\n"
    "    records = [read(path) for path in layout.records.glob('*.json')]\n"
    "    matches = [r for r in records if r['identity'] == identity]\n"
    "    if len(matches) != 1:\n"
    "        raise ValueError('the identity has no unique record')\n"
    "    return matches[0]\n"
)


def test_lookup_drafts_copy_from_the_context(engine, script):
    body = request(
        "Repeat this function exactly:\n\n" + PASSAGE,
        max_output_tokens=200,
        reasoning={"effort": "none"},
    )
    reply = PASSAGE + "<|im_end|>"
    script(reply)
    plain, _ = run(engine, body, drafts=0)
    script(reply)
    copied, metrics = run(engine, body, drafts=0, lookups=8)
    assert copied == plain  # the sampler decides every token; lookup only batches them
    assert metrics["lookup_rounds"] > 0 and metrics["lookup_accept_rate"] > 0.6
    assert copied[-1]["usage"]["output_tokens"] == len(engine.adapter.codec.encode(reply))
    # with MTP too: lookup wins where the context repeats, MTP drafts elsewhere
    script(reply)
    combined, metrics = run(engine, body, lookups=8)
    assert combined == plain and metrics["lookup_rounds"] > 0

    # wide rounds through the prefill path: same tokens, caches still aligned
    engine.settings.verify_prefill_schedule = ((0, 3),)
    try:
        script(reply)
        wide, metrics = run(engine, body, session="wide", lookups=8)
    finally:
        engine.settings.verify_prefill_schedule = ((0, 0),)
    assert wide[1:] == plain[1:] and metrics["lookup_rounds"] > 0
    session = engine.sessions.sessions["wide"]
    assert session.draft.offset() == len(session.tokens) - 1
    assert cache_offset(session.cache) == len(session.tokens)
    engine.sessions.release("wide")
