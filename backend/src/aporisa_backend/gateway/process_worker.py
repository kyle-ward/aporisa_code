"""The real WorkerClient: a worker subprocess behind an inherited socketpair (14.3).

- The worker runs in its own session (process group); close() ends that group.
- Its environment is an allowlist: the API key and other deployment secrets never reach it.
- stdout carries nothing (third-party libraries print there); a bounded stderr tail is kept
  while it starts, for the failure message, and discarded afterwards.
- Closing a generation's iterator before its terminal message sends `cancel` and waits for
  the worker's `cancelled`, so admission is released only once the engine is free. A worker
  that does not confirm in time is killed and recovery takes over.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
import socket
import sys
from collections import deque
from collections.abc import AsyncIterator
from pathlib import Path

from ..configs.engine import ENGINE, EngineConfig
from ..configs.models import ModelProfile
from ..console import emit
from ..ipc.frames import FrameError, encode, read_frame
from ..protocol.errors import ProtocolError
from .events import new_id
from .worker_client import Job, WorkerClient, WorkerGone

ENV_ALLOWLIST = ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME")
WORKER_ENV = {
    "HF_HUB_OFFLINE": "1",
    "TRANSFORMERS_OFFLINE": "1",
    "TRANSFORMERS_VERBOSITY": "error",
    "TOKENIZERS_PARALLELISM": "false",
    "PYTHONUNBUFFERED": "1",
}
TERMINAL = frozenset({"finished", "failed", "rejected"})
_GONE = object()


class ProcessWorker(WorkerClient):
    def __init__(
        self,
        model_dir: Path,
        model: dict,
        profile: ModelProfile,
        *,
        draft_dir: Path | None = None,
        engine: EngineConfig = ENGINE,
        stop_timeout_s: float = 15,
        python: str = sys.executable,
        snapshot_budget_bytes: int | None = None,
        kv_cache: dict | None = None,
    ):
        self.model_dir, self.model, self.profile = Path(model_dir), model, profile
        self.draft_dir = Path(draft_dir) if draft_dir is not None else None
        self.engine, self.stop_timeout_s, self.python = engine, stop_timeout_s, python
        self.snapshot_budget_bytes = snapshot_budget_bytes
        self.kv_cache = kv_cache  # {"dir", "identity", "draft_identity"}: the SSD cache
        self.proc: asyncio.subprocess.Process | None = None
        self.writer: asyncio.StreamWriter | None = None
        self.reader_task: asyncio.Task | None = None
        self.stderr_task: asyncio.Task | None = None
        self.stderr_tail: deque[str] = deque(maxlen=engine.startup_stderr_lines)
        self.keep_stderr = True
        self.jobs: dict[str, asyncio.Queue] = {}
        self.calls: dict[str, asyncio.Future] = {}
        self.ready: asyncio.Future | None = None
        self.dead = False
        self.info: dict = {}

    # --- lifecycle --------------------------------------------------------------------------

    async def start(self) -> None:
        parent, child = socket.socketpair()
        env = {k: os.environ[k] for k in ENV_ALLOWLIST if k in os.environ} | WORKER_ENV
        try:
            self.proc = await asyncio.create_subprocess_exec(
                self.python,
                "-m",
                "aporisa_backend.engine.main",
                "--fd",
                str(child.fileno()),
                pass_fds=(child.fileno(),),
                start_new_session=True,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
        finally:
            child.close()
        reader, self.writer = await asyncio.open_connection(sock=parent, limit=1 << 20)
        loop = asyncio.get_running_loop()
        self.ready = loop.create_future()
        self.stderr_task = asyncio.create_task(self._drain_stderr(), name="worker-stderr")
        self.reader_task = asyncio.create_task(self._read(reader), name="worker-reader")
        await self._send(
            {
                "op": "init",
                "model_dir": str(self.model_dir),
                "model": self.model,
                "adapter": self.profile.adapter,
                "kv_bytes_per_token": self.profile.kv_bytes_per_token,
                "draft_dir": str(self.draft_dir) if self.draft_dir is not None else None,
                "draft_schedule": [list(step) for step in self.profile.draft_schedule],
                "lookup_schedule": [list(step) for step in self.profile.lookup_schedule],
                "verify_prefill_schedule": [
                    list(step) for step in self.profile.verify_prefill_schedule
                ],
                "draft_kv_bytes_per_token": self.profile.draft_kv_bytes_per_token,
                "snapshot_budget_bytes": self.snapshot_budget_bytes,
                "kv_cache": self.kv_cache,
                "engine": self.engine.as_dict(),
            }
        )
        try:
            self.info = await self.ready
        except WorkerGone:
            code = await self._exit_code()
            tail = list(self.stderr_tail)
            emit("ERROR", f"Worker exited during startup (code {code}).")
            for line in tail[-12:]:
                emit("INFO", f"worker: {line}")
            raise RuntimeError("worker failed to start") from None
        self.keep_stderr = False
        self.stderr_tail.clear()

    async def _exit_code(self) -> int | None:
        if self.proc is None:
            return None
        with contextlib.suppress(TimeoutError):
            return await asyncio.wait_for(self.proc.wait(), 5)
        return None

    async def _drain_stderr(self) -> None:
        stream = self.proc.stderr
        while True:
            line = await stream.readline()
            if not line:
                return
            if self.keep_stderr:
                self.stderr_tail.append(line.decode(errors="replace").rstrip()[:500])

    async def close(self) -> None:
        proc = self.proc
        if proc is not None and proc.returncode is None and not self.dead:
            with contextlib.suppress(Exception):
                await self._send({"op": "shutdown"})
        if proc is not None:
            try:
                await asyncio.wait_for(proc.wait(), self.stop_timeout_s)
            except TimeoutError:
                self._signal_group(signal.SIGTERM)
                try:
                    await asyncio.wait_for(proc.wait(), 5)
                except TimeoutError:
                    self._signal_group(signal.SIGKILL)
                    await proc.wait()
        self._mark_dead()
        for task in (self.reader_task, self.stderr_task):
            if task is not None:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        if self.writer is not None:
            self.writer.close()
            with contextlib.suppress(Exception):
                await self.writer.wait_closed()

    def kill(self) -> None:
        """Ends the worker's process group now (a cancel that was never confirmed)."""
        self._signal_group(signal.SIGKILL)
        self._mark_dead()

    def _signal_group(self, sig: int) -> None:
        if self.proc is None or self.proc.returncode is not None:
            return
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(self.proc.pid, sig)

    @property
    def alive(self) -> bool:
        return not self.dead and self.proc is not None and self.proc.returncode is None

    # --- channel ----------------------------------------------------------------------------

    async def _send(self, message: dict) -> None:
        if self.dead or self.writer is None:
            raise WorkerGone
        try:
            self.writer.write(encode(message))
            await self.writer.drain()
        except (ConnectionError, OSError, FrameError) as error:
            self._mark_dead()
            raise WorkerGone from error

    async def _read(self, reader: asyncio.StreamReader) -> None:
        try:
            while True:
                message = await read_frame(reader)
                if message is None:
                    break
                self._dispatch(message)
        except (FrameError, ConnectionError, OSError):
            pass
        finally:
            self._mark_dead()

    def _dispatch(self, message: dict) -> None:
        kind = message.get("type")
        if kind == "ready":
            if self.ready is not None and not self.ready.done():
                self.ready.set_result(message.get("info", {}))
            return
        key = message.get("id")
        if kind in ("counted", "status"):
            future = self.calls.pop(key, None)
            if future is not None and not future.done():
                future.set_result(message)
            return
        queue = self.jobs.get(key)
        if queue is not None:
            queue.put_nowait(message)

    def _mark_dead(self) -> None:
        if self.dead:
            return
        self.dead = True
        if self.ready is not None and not self.ready.done():
            self.ready.set_exception(WorkerGone())
        for queue in self.jobs.values():
            queue.put_nowait(_GONE)
        for future in self.calls.values():
            if not future.done():
                future.set_exception(WorkerGone())
        self.calls.clear()

    async def _call(self, message: dict, timeout_s: float = 30) -> dict:
        call_id = new_id("call")
        future = asyncio.get_running_loop().create_future()
        self.calls[call_id] = future
        try:
            await self._send({**message, "id": call_id})
            return await asyncio.wait_for(future, timeout_s)
        except TimeoutError:
            raise WorkerGone from None
        finally:
            self.calls.pop(call_id, None)

    # --- operations -------------------------------------------------------------------------

    async def generate(self, job: Job) -> AsyncIterator[dict]:
        queue: asyncio.Queue = asyncio.Queue()
        self.jobs[job.id] = queue
        ended = False
        try:
            await self._send(
                {
                    "op": "generate",
                    "id": job.id,
                    "response_id": job.response_id,
                    "request": job.request,
                    "session": job.session,
                }
            )
            while True:
                message = await queue.get()
                if message is _GONE:
                    ended = True
                    raise WorkerGone
                if message.get("type") in TERMINAL:
                    ended = True
                yield message
                if ended:
                    return
        finally:
            if not ended and self.alive:
                await self._cancel(job.id, queue)
            self.jobs.pop(job.id, None)

    async def _cancel(self, job_id: str, queue: asyncio.Queue) -> None:
        try:
            await self._send({"op": "cancel", "id": job_id})
            async with asyncio.timeout(self.engine.cancel_timeout_s):
                while True:
                    message = await queue.get()
                    if message is _GONE or message.get("type") == "cancelled":
                        return
        except (WorkerGone, TimeoutError):
            if self.alive:
                emit("REPAIRABLE", "Worker did not confirm a cancel in time; restarting it.")
                self.kill()

    async def count_tokens(self, request: dict) -> int:
        reply = await self._call({"op": "count_tokens", "request": request})
        if "input_tokens" not in reply:
            raise ProtocolError("internal_error", "The request could not be counted.")
        return int(reply["input_tokens"])

    async def interrupt(self, job_id: str) -> None:
        with contextlib.suppress(WorkerGone):
            await self._send({"op": "interrupt", "id": job_id})

    async def release_session(self, session: str) -> None:
        with contextlib.suppress(WorkerGone):
            await self._send({"op": "release_session", "session": session})

    async def status(self) -> dict:
        reply = await self._call({"op": "status"}, timeout_s=10)
        return reply.get("status", {})
