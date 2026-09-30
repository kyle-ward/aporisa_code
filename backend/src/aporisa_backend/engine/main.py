"""Worker process entry (DEVELOPMENT_PLAN.md 14.3, 14.5).

    python -m aporisa_backend.engine.main --fd <inherited socketpair fd>

Started only by the gateway (gateway/process_worker.py). The first frame is `init` (model
directory, public model, engine policy); `ready` is sent after load and warmup.

Threads:
- main: owns MLX, the sessions and the token map writes; runs generate / release_session /
  shutdown one at a time from the inbox.
- control: reads frames; interrupt and cancel only set flags the main thread checks between
  prefill chunks and decoded tokens; count_tokens and status are answered here (own
  tokenizer, thread-safe token map), so they never wait behind a generation.

A cancel is confirmed with `cancelled` only once the job no longer runs, after all of its
other messages. When the gateway goes away (end of stream), the worker stops.
"""

from __future__ import annotations

import argparse
import os
import queue
import socket
import sys
import threading
import traceback
from pathlib import Path

from ..ipc.frames import Channel, FrameError
from ..process_limits import raise_open_files
from .generate import Cancelled, JobFlags
from .tokens import Codec

EXIT_GRACE_S = 30


class Worker:
    def __init__(self, channel: Channel, init: dict):
        from . import runtime

        self.channel, self.init = channel, init
        self.engine = runtime.load(init)
        runtime.warmup(self.engine, init["model"]["id"])
        adapter_class = runtime.ADAPTERS[init["adapter"]]
        self.count_adapter = adapter_class(Codec(Path(init["model_dir"])), init["model"])
        self.inbox: queue.Queue[dict] = queue.Queue()
        self.lock = threading.Lock()
        self.current: tuple[str, JobFlags] | None = None
        self.pending: dict[str, JobFlags] = {}
        self.view: dict = {}
        self._update_view()

    def send(self, message: dict) -> None:
        try:
            self.channel.send(message)
        except OSError:
            pass  # the gateway is gone; the control thread handles the shutdown

    def _update_view(self) -> None:
        import mlx.core as mx

        self.view = {
            **self.engine.sessions.status(),
            **self.engine.info,
            "token_map_turns": len(self.engine.token_map),
            "active_memory_bytes": int(mx.get_active_memory()),
            "last": dict(self.engine.metrics),
        }

    # --- main thread ----------------------------------------------------------------------

    def run(self) -> None:
        threading.Thread(target=self._control, name="control", daemon=True).start()
        self.send({"type": "ready", "info": self.engine.info})
        while True:
            message = self.inbox.get()
            op = message["op"]
            if op == "generate":
                self._generate(message)
            elif op == "release_session":
                self.engine.sessions.release(message["session"])
                self._update_view()
            elif op == "shutdown":
                return

    def _generate(self, message: dict) -> None:
        job_id = message["id"]
        with self.lock:
            flags = self.pending.pop(job_id, None) or JobFlags()
            if flags.cancel.is_set():
                self.send({"id": job_id, "type": "cancelled"})
                return
            self.current = (job_id, flags)
        try:
            self.engine.generate(message, self.send, flags)
        except Cancelled:
            pass
        except Exception:
            traceback.print_exc(file=sys.stderr)
            # The job's session may be half updated; drop every session (they only
            # accelerate) and report an engine failure for this job.
            self.engine.sessions.sessions.clear()
            self.send({"id": job_id, "type": "failed", "code": "engine_failure"})
        finally:
            with self.lock:
                self.current = None
                cancelled = flags.cancel.is_set()
            if cancelled:
                self.send({"id": job_id, "type": "cancelled"})
            self._update_view()

    # --- control thread -------------------------------------------------------------------

    def _flags(self, job_id: str) -> JobFlags | None:
        if self.current is not None and self.current[0] == job_id:
            return self.current[1]
        return self.pending.get(job_id)

    def _control(self) -> None:
        while True:
            try:
                message = self.channel.recv()
            except (FrameError, OSError):
                message = None
            if message is None:
                self._abandon()
                return
            op = message.get("op")
            job_id = message.get("id")
            if op == "generate":
                with self.lock:
                    self.pending[job_id] = JobFlags()
                self.inbox.put(message)
            elif op == "cancel":
                with self.lock:
                    flags = self._flags(job_id)
                    if flags is not None:
                        flags.cancel.set()
                if flags is None:
                    self.send({"id": job_id, "type": "cancelled"})
            elif op == "interrupt":
                with self.lock:
                    flags = self._flags(job_id)
                    if flags is not None:
                        flags.interrupt.set()
            elif op == "count_tokens":
                try:
                    count = self.engine.count(message["request"], self.count_adapter)
                    self.send({"id": job_id, "type": "counted", "input_tokens": count})
                except Exception:
                    traceback.print_exc(file=sys.stderr)
                    self.send({"id": job_id, "type": "counted", "error": "internal_error"})
            elif op == "status":
                self.send({"id": job_id, "type": "status", "status": dict(self.view)})
            elif op == "release_session":
                self.inbox.put(message)
            elif op == "shutdown":
                self._cancel_all()
                self.inbox.put(message)
                return

    def _cancel_all(self) -> None:
        with self.lock:
            for flags in [*self.pending.values(), *([self.current[1]] if self.current else [])]:
                flags.cancel.set()

    def _abandon(self) -> None:
        """The gateway closed the channel: stop now, hard-exit if MLX does not return."""
        self._cancel_all()
        self.inbox.put({"op": "shutdown"})
        timer = threading.Timer(EXIT_GRACE_S, lambda: os._exit(1))
        timer.daemon = True
        timer.start()


def main() -> None:
    parser = argparse.ArgumentParser(description="Aporisa inference worker (internal)")
    parser.add_argument("--fd", type=int, required=True)
    args = parser.parse_args()
    channel = Channel(socket.socket(fileno=args.fd))
    init = channel.recv()
    if not init or init.get("op") != "init":
        sys.exit(2)
    raise_open_files(init["engine"]["open_files"])
    worker = Worker(channel, init)
    worker.run()
    channel.close()
    sys.stderr.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
