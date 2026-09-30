"""Sessions: live caches, item-boundary snapshots and the memory budget (14.5, 6).

A session is one MLX cache plus the exact token list T it holds, the logits after T's last
token when known, and up to K snapshots. A snapshot at offset o is a copy of every
recurrent (ArraysCache) state at o; KV caches are not copied, restore truncates them
(B0-8: bit-exact on the real model). Matching a request's tokens R:

  live      T is a prefix of R            -> append R[len(T):]
  snapshot  deepest snapshot o with T[:o] == R[:o] -> restore, append (o == len(R)
            only when the snapshot kept the logits there)
  cold      otherwise                     -> fresh cache

Sessions are keyed by prompt_cache_key, else `conn:<id>` for a WebSocket connection; a
request without either gets a throwaway session. Everything here is an accelerator: losing
it only costs time.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field

import mlx.core as mx

GIB = 1024**3


def cache_offset(cache: list) -> int:
    return max(int(getattr(entry, "offset", 0) or 0) for entry in cache)


def _recurrent(cache: list) -> dict[int, list]:
    from mlx_vlm.models.cache import ArraysCache

    return {i: list(entry.state) for i, entry in enumerate(cache) if isinstance(entry, ArraysCache)}


def _nbytes(values) -> int:
    return sum(v.nbytes for v in values if v is not None)


def cache_bytes(cache: list) -> int:
    from mlx_vlm.models.cache import ArraysCache

    total = 0
    for entry in cache:
        if isinstance(entry, ArraysCache):
            total += _nbytes(entry.state)
        else:
            total += int(getattr(entry, "nbytes", 0) or 0)
    return total


@dataclass
class Snapshot:
    offset: int
    states: dict[int, list]
    nbytes: int
    logits: mx.array | None = None  # after the token at offset-1; lets a retry skip prefill


@dataclass
class Session:
    key: str | None
    cache: list
    tokens: list[int] = field(default_factory=list)
    logits: mx.array | None = None
    snapshots: list[Snapshot] = field(default_factory=list)
    last_used: float = field(default_factory=time.monotonic)
    busy: bool = False

    def nbytes(self) -> int:
        return cache_bytes(self.cache) + sum(s.nbytes for s in self.snapshots)

    def snapshot(self, limit: int) -> None:
        """Records the recurrent state at the current offset; keeps the latest `limit`."""
        offset = cache_offset(self.cache)
        if self.snapshots and self.snapshots[-1].offset == offset:
            return
        states = _recurrent(self.cache)
        values = [v for state in states.values() for v in state if v is not None]
        logits = self.logits if len(self.tokens) == offset else None
        mx.eval(values, *([logits] if logits is not None else []))
        size = _nbytes(values) + (logits.nbytes if logits is not None else 0)
        self.snapshots.append(Snapshot(offset, states, size, logits))
        del self.snapshots[:-limit]

    def restore(self, snap: Snapshot) -> None:
        from mlx_vlm.models.cache import ArraysCache

        for index, entry in enumerate(self.cache):
            if isinstance(entry, ArraysCache):
                entry.state = list(snap.states[index])
            else:
                excess = int(entry.offset) - snap.offset
                if excess < 0:
                    raise ValueError("cannot restore forward: KV is shorter than the snapshot")
                if excess:
                    entry.trim(excess)
        if cache_offset(self.cache) != snap.offset:
            raise ValueError("restore did not reach the snapshot offset")
        self.tokens = self.tokens[: snap.offset]
        self.logits = snap.logits
        self.snapshots = [s for s in self.snapshots if s.offset <= snap.offset]


@dataclass
class Match:
    session: Session
    cached: int
    path: str  # live | snapshot | cold


class SessionStore:
    def __init__(
        self,
        make_cache: Callable[[], list],
        *,
        budget_bytes: int | Callable[[SessionStore], int],
        kv_bytes_per_token: int,
        max_snapshots: int = 16,
    ):
        self.make_cache = make_cache
        self.budget_bytes = budget_bytes
        self.kv_bytes_per_token = kv_bytes_per_token
        self.max_snapshots = max_snapshots
        self.sessions: dict[str, Session] = {}
        self.evictions = 0

    @property
    def budget_bytes(self) -> int:
        """Memory all sessions may hold now; a callable budget is re-evaluated each time."""
        budget = self._budget(self) if callable(self._budget) else self._budget
        return max(0, int(budget))

    @budget_bytes.setter
    def budget_bytes(self, value: int | Callable[[SessionStore], int]) -> None:
        self._budget = value

    def total_bytes(self) -> int:
        return sum(s.nbytes() for s in self.sessions.values())

    def acquire(self, key: str | None, tokens: list[int]) -> Match:
        session = self.sessions.get(key) if key else None
        if session is None:
            session = Session(key, self.make_cache())
            if key:
                self.sessions[key] = session
            return self._mark(Match(session, 0, "cold"))
        known = session.tokens
        n = len(known)
        if (
            n <= len(tokens)
            and tokens[:n] == known
            and (n < len(tokens) or session.logits is not None)
        ):
            return self._mark(Match(session, n, "live"))
        for snap in reversed(session.snapshots):
            o = snap.offset
            usable = o < len(tokens) or (o == len(tokens) and snap.logits is not None)
            if 0 < o <= n and usable and known[:o] == tokens[:o]:
                session.restore(snap)
                return self._mark(Match(session, o, "snapshot"))
        session.cache, session.tokens, session.logits, session.snapshots = (
            self.make_cache(),
            [],
            None,
            [],
        )
        return self._mark(Match(session, 0, "cold"))

    def _mark(self, match: Match) -> Match:
        match.session.busy = True
        match.session.last_used = time.monotonic()
        return match

    def done(self, session: Session) -> None:
        session.busy = False
        session.last_used = time.monotonic()
        if session.key is None:
            session.cache, session.snapshots, session.logits = [], [], None

    def estimate(self, total_tokens: int) -> int:
        return total_tokens * self.kv_bytes_per_token

    def make_room(self, session: Session, total_tokens: int) -> None:
        """Evicts idle sessions (LRU, whole) until this request's estimate fits the budget.

        A request that alone exceeds the budget keeps running; it just keeps no snapshots
        beyond the one it takes at the prompt end.
        """
        budget = self.budget_bytes
        need = self.estimate(total_tokens) + sum(s.nbytes for s in session.snapshots)
        others = sorted(
            (s for s in self.sessions.values() if s is not session and not s.busy),
            key=lambda s: s.last_used,
        )
        used = sum(s.nbytes() for s in others)
        while others and used + need > budget:
            victim = others.pop(0)
            used -= victim.nbytes()
            self.sessions.pop(victim.key, None)
            self.evictions += 1
        if used + need > budget:
            session.snapshots = session.snapshots[-1:]
        mx.clear_cache()

    def snapshot_limit(self, session: Session, total_tokens: int) -> int:
        """Snapshots this session may hold now: K, fewer when memory is short."""
        others = sum(s.nbytes() for s in self.sessions.values() if s is not session)
        spare = self.budget_bytes - others - self.estimate(total_tokens)
        per = session.snapshots[-1].nbytes if session.snapshots else 0
        if per <= 0:
            return self.max_snapshots
        return max(1, min(self.max_snapshots, spare // per))

    def release(self, key: str) -> None:
        session = self.sessions.get(key)
        if session is not None and not session.busy:
            del self.sessions[key]
            mx.clear_cache()

    def status(self) -> dict:
        return {
            "sessions": len(self.sessions),
            "session_bytes": sum(s.nbytes() for s in self.sessions.values()),
            "budget_bytes": self.budget_bytes,
            "evictions": self.evictions,
        }
