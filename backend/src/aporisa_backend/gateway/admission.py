"""Bounded FIFO admission (a port of local_llm's Admission).

Owned by the event loop: promotion and cancellation are atomic, so a cancelled waiter can
never leak a slot and a released slot always goes to the oldest waiter.
"""

from __future__ import annotations

import asyncio
from collections import deque

from ..protocol.errors import ProtocolError


def not_ready() -> ProtocolError:
    return ProtocolError("service_not_ready", "The service is not ready.")


class Admission:
    def __init__(self, capacity: int, queue_size: int, timeout: float):
        self.capacity, self.queue_size, self.timeout = capacity, queue_size, timeout
        self.active = 0
        self.waiters: deque[asyncio.Future] = deque()
        self.accepting = False
        self.idle = asyncio.Event()
        self.idle.set()

    async def acquire(self) -> None:
        if not self.accepting:
            raise not_ready()
        if self.active < self.capacity and not self.waiters:
            self.active += 1
            self.idle.clear()
            return
        if len(self.waiters) >= self.queue_size:
            raise ProtocolError("queue_full", "Inference capacity is full; retry later.")
        future = asyncio.get_running_loop().create_future()
        self.waiters.append(future)
        try:
            await asyncio.wait_for(asyncio.shield(future), self.timeout)
        except TimeoutError:
            self._abandon(future)
            raise ProtocolError("queue_timeout", "Inference queue wait timed out.") from None
        except BaseException:
            self._abandon(future)
            raise

    def _abandon(self, future: asyncio.Future) -> None:
        if future in self.waiters:
            self.waiters.remove(future)
        elif future.done() and not future.cancelled() and future.exception() is None:
            self.release()  # promoted just before the waiter gave up
        if not future.done():
            future.cancel()

    def release(self) -> None:
        self.active -= 1
        if self.accepting and self.waiters:
            self.active += 1
            self.waiters.popleft().set_result(None)
        if self.active == 0:
            self.idle.set()

    def close(self) -> None:
        self.accepting = False
        while self.waiters:
            waiter = self.waiters.popleft()
            if not waiter.done():
                waiter.set_exception(not_ready())
