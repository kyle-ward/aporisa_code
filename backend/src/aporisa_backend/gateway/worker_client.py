"""The gateway's view of the inference worker (DEVELOPMENT_PLAN.md 14.3).

The real client speaks length-prefixed JSON over an inherited socketpair to the worker
process; the fake worker implements the same interface in-process for tests and for
running the conformance suite without a model.

Messages a generation yields, in order:
  accepted {input_tokens, cached_tokens, restore_path} | rejected {code}
  item_added {kind, name?}   delta {text}   item_done {item}      (repeated)
  finished {status, reason, usage} | failed {code}
Closing the generation's iterator before `finished`/`failed` cancels it; implementations
return only once the worker has stopped working on it.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass


class WorkerGone(Exception):
    """The worker process died or broke the IPC protocol."""


@dataclass(frozen=True)
class Job:
    id: str
    response_id: str
    request: dict
    session: str | None


class WorkerClient(ABC):
    @abstractmethod
    async def start(self) -> None:
        """Starts the worker and returns once it is loaded and warmed up."""

    @abstractmethod
    async def close(self) -> None: ...

    @property
    @abstractmethod
    def alive(self) -> bool: ...

    @abstractmethod
    def generate(self, job: Job) -> AsyncIterator[dict]: ...

    @abstractmethod
    async def count_tokens(self, request: dict) -> int: ...

    @abstractmethod
    async def interrupt(self, job_id: str) -> None: ...

    @abstractmethod
    async def release_session(self, session: str) -> None: ...

    @abstractmethod
    async def status(self) -> dict: ...
