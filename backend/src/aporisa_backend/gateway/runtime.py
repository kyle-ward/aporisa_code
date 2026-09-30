"""Gateway runtime: service state, admission, one response's lifecycle, worker recovery.

States: starting -> ready -> recovering -> ready | failed; shutdown: stopping -> stopped.
Shutdown order (AGENTS.md): close admission, wake waiters, bounded drain, cancel the rest,
stop the worker's process group.
"""

from __future__ import annotations

import asyncio
import time
from collections import Counter
from collections.abc import AsyncIterator, Callable

from ..configs.limits import LIMITS, ServiceLimits
from ..configs.models import ModelProfile, public_model
from ..logging_config import event
from ..protocol import validation
from ..protocol.errors import ProtocolError
from .admission import Admission, not_ready
from .events import Assembler, AssemblyError, new_id
from .worker_client import Job, WorkerClient, WorkerGone

KEEPALIVE = object()
# System memory-pressure deltas the worker reports per request and for its startup.
PRESSURE_FIELDS = (
    "sys_pageins",
    "sys_pageouts",
    "sys_compressions",
    "sys_decompressions",
    "sys_swapins",
    "sys_swapouts",
    "swap_growth_bytes",
    "major_faults",
    "compressor_bytes",
)
WORKER_STATUS_TIMEOUT_S = 2
WORKER_STREAM_CODES = {
    "server_error",
    "engine_failure",
    "structured_output_invalid",
    "tool_call_invalid",
}


class Runtime:
    def __init__(
        self,
        alias: str,
        profile: ModelProfile,
        worker_factory: Callable[[], WorkerClient],
        limits: ServiceLimits = LIMITS,
    ):
        self.alias, self.profile, self.limits = alias, profile, limits
        self.model = public_model(alias, profile)
        self.worker_factory = worker_factory
        self.worker: WorkerClient | None = None
        self.admission = Admission(
            limits.active_requests, limits.queued_requests, limits.queue_timeout_s
        )
        self.state = "starting"
        self.runs: set[ResponseRun] = set()
        self.counts: Counter = Counter()
        self.restarts = 0
        self.last_error_code: str | None = None
        self.monitor: asyncio.Task | None = None

    # --- lifecycle --------------------------------------------------------------------------

    async def start(self) -> None:
        event("starting")
        try:
            await self._start_worker()
        except BaseException:
            self.state = "failed"
            event("startup_failed")
            await self._stop_worker()
            raise
        self.monitor = asyncio.create_task(self._watch(), name="worker-monitor")

    async def _start_worker(self) -> None:
        event("worker_starting")
        started = time.monotonic()
        self.worker = self.worker_factory()
        await asyncio.wait_for(self.worker.start(), self.limits.worker_start_timeout_s)
        info = getattr(self.worker, "info", None) or {}
        event(
            "worker_ready",
            duration_ms=round((time.monotonic() - started) * 1000),
            released_cache_bytes=info.get("released_cache_bytes"),
            **{key: (info.get("startup") or {}).get(key) for key in PRESSURE_FIELDS},
        )
        self.state = "ready"
        self.admission.accepting = True
        self.last_error_code = None
        event("ready")

    async def _stop_worker(self) -> None:
        worker, self.worker = self.worker, None
        if worker is not None:
            await worker.close()

    async def _watch(self) -> None:
        while self.state not in ("stopping", "stopped", "failed"):
            await asyncio.sleep(1)
            if self.worker is not None and self.worker.alive:
                continue
            await self._recover()

    async def _recover(self) -> None:
        self.state = "recovering"
        self.last_error_code = "engine_failure"
        self.admission.close()
        event("worker_failed")
        await self._cancel_runs()
        await self._stop_worker()
        while self.restarts < self.limits.restart_attempts and self.state == "recovering":
            self.restarts += 1
            event("worker_restart", attempt=self.restarts)
            await asyncio.sleep(self.limits.restart_backoff_s)
            try:
                await self._start_worker()
                return
            except Exception:
                await self._stop_worker()
        if self.state == "recovering":
            self.state = "failed"
            event("circuit_open")

    async def _cancel_runs(self) -> None:
        for run in list(self.runs):
            run.cancel()
        await asyncio.sleep(0)

    def begin_shutdown(self) -> None:
        self.state = "stopping"
        self.admission.close()

    async def close(self) -> None:
        self.begin_shutdown()
        event("stopping")
        if self.monitor:
            self.monitor.cancel()
            await asyncio.gather(self.monitor, return_exceptions=True)
        try:
            await asyncio.wait_for(self.admission.idle.wait(), self.limits.shutdown_drain_s)
        except TimeoutError:
            await self._cancel_runs()
        await self._stop_worker()
        self.state = "stopped"
        event("stopped")

    # --- requests ---------------------------------------------------------------------------

    def validate(self, params: dict) -> None:
        if params["model"] != self.alias:
            raise ProtocolError("model_not_found", "Model not found.", "model")
        validation.request_violation(params, self.model)

    def ready(self) -> bool:
        return self.state == "ready" and self.worker is not None and self.worker.alive

    async def count_tokens(self, params: dict) -> int:
        if not self.ready():
            raise not_ready()
        try:
            return await self.worker.count_tokens(params)
        except WorkerGone:
            raise not_ready() from None

    def new_run(self, params: dict, *, transport: str, session: str | None) -> ResponseRun:
        return ResponseRun(self, params, transport=transport, session=session)

    async def status(self) -> dict:
        """/health/runtime: gateway state plus the worker's own view (numbers only).

        The worker answers from its control thread even while generating; when it cannot
        answer within WORKER_STATUS_TIMEOUT_S the gateway part is still returned.
        """
        worker = None
        if self.ready():
            try:
                worker = await asyncio.wait_for(self.worker.status(), WORKER_STATUS_TIMEOUT_S)
            except (TimeoutError, WorkerGone):
                worker = None
        return {**self.snapshot(), "worker": worker}

    def snapshot(self) -> dict:
        return {
            "state": self.state,
            "active": self.admission.active,
            "queued": len(self.admission.waiters),
            "restarts": self.restarts,
            "counts": dict(self.counts),
            "last_error_code": self.last_error_code,
        }


class ResponseRun:
    """One generation: admission slot, worker job, timers and event assembly."""

    def __init__(self, runtime: Runtime, params: dict, *, transport: str, session: str | None):
        self.runtime, self.params, self.transport = runtime, params, transport
        self.response_id = new_id("resp")
        self.job = Job(new_id("job"), self.response_id, params, session)
        self.assembler = Assembler(self.response_id, params["model"])
        self.stream: AsyncIterator[dict] | None = None
        self._pending: asyncio.Future | None = None
        self.acquired = False
        self.closed = False
        self.cancelled = asyncio.Event()
        self.accepted: dict = {}
        self.result: dict = {}
        self.queue_ms: int | None = None
        self.status = "rejected"
        self.started = time.monotonic()

    async def open(self) -> None:
        """Admission and the worker's accept/reject; raises ProtocolError before any event."""
        runtime = self.runtime
        queued = time.monotonic()
        await runtime.admission.acquire()
        self.queue_ms = round((time.monotonic() - queued) * 1000)
        self.acquired = True
        runtime.runs.add(self)
        try:
            if not runtime.ready():
                raise not_ready()
            self.stream = runtime.worker.generate(self.job)
            first = await asyncio.wait_for(anext(self.stream), runtime.limits.request_timeout_s)
        except ProtocolError:
            await self.close()
            raise
        except (WorkerGone, StopAsyncIteration, TimeoutError):
            await self.close()
            raise not_ready() from None
        if first.get("type") == "rejected":
            await self.close()
            code = first.get("code", "internal_error")
            param = "input" if code == "context_length_exceeded" else None
            raise ProtocolError(code, _REJECTED.get(code, _UNSERVED), param)
        if first.get("type") != "accepted":
            await self.close()
            raise ProtocolError("internal_error", "The request could not be served.")
        self.accepted = first
        self.status = "cancelled"  # until a terminal event says otherwise

    def interrupt(self) -> None:
        if self.runtime.worker is not None and not self.closed:
            asyncio.ensure_future(self.runtime.worker.interrupt(self.job.id))

    def cancel(self) -> None:
        self.cancelled.set()

    async def events(self) -> AsyncIterator[object]:
        """Protocol events (dicts) and KEEPALIVE markers, ending with exactly one terminal."""
        limits = self.runtime.limits
        assembler = self.assembler
        yield assembler.created()
        deadline = self.started + limits.request_timeout_s
        last_delta: float | None = None
        output_bytes = 0
        cancel_wait = asyncio.ensure_future(self.cancelled.wait())
        try:
            while True:
                now = time.monotonic()
                wait = deadline - now
                if last_delta is not None:
                    wait = min(wait, last_delta + limits.idle_timeout_s - now)
                if wait <= 0:
                    yield await self._fail(
                        "inference_timeout", "The inference deadline was exceeded."
                    )
                    return
                # A pending read survives keepalive ticks: cancelling it would throw into the
                # worker's generator and end the job.
                if self._pending is None:
                    self._pending = asyncio.ensure_future(anext(self.stream))
                receive = self._pending
                done, _ = await asyncio.wait(
                    {receive, cancel_wait},
                    timeout=min(wait, limits.sse_keepalive_s),
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if cancel_wait in done and receive not in done:
                    yield await self._fail("engine_failure", "The inference engine failed.")
                    return
                if receive not in done:
                    now = time.monotonic()
                    if now < deadline and (
                        last_delta is None or now < last_delta + limits.idle_timeout_s
                    ):
                        yield KEEPALIVE
                    continue
                self._pending = None
                try:
                    message = receive.result()
                except (StopAsyncIteration, WorkerGone):
                    yield await self._fail("engine_failure", "The inference engine failed.")
                    return
                try:
                    kind = message.get("type")
                    if kind == "item_added":
                        for item in assembler.item_added(message["kind"], message.get("name")):
                            yield item
                    elif kind == "delta":
                        last_delta = time.monotonic()
                        output_bytes += len(message["text"].encode())
                        if output_bytes > limits.max_output_bytes:
                            yield await self._fail(
                                "output_limit_exceeded", "The output byte limit was exceeded."
                            )
                            return
                        for item in assembler.delta(message["text"]):
                            yield item
                    elif kind == "item_done":
                        for item in assembler.item_done(message["item"]):
                            yield item
                    elif kind == "finished":
                        self.status, self.result = message["status"], message
                        yield assembler.terminal(
                            message["status"], usage=message["usage"], reason=message.get("reason")
                        )
                        await self._finish()
                        return
                    elif kind == "failed":
                        code = message.get("code")
                        code = code if code in WORKER_STREAM_CODES else "server_error"
                        if code == "tool_call_invalid":
                            detail = message.get("detail")
                            text = _TOOL_CALL_INVALID.get(detail, _TOOL_CALL_INVALID["malformed"])
                        else:
                            text = _FAILED[code]
                        self.status = "failed"
                        yield assembler.terminal("failed", error={"code": code, "message": text})
                        await self._finish()
                        return
                    else:
                        raise AssemblyError(f"unexpected worker message {kind!r}")
                except (AssemblyError, KeyError, TypeError):
                    yield await self._fail("server_error", "The response could not be assembled.")
                    return
        finally:
            cancel_wait.cancel()

    async def _fail(self, code: str, message: str) -> dict:
        self.status = "failed"
        terminal = self.assembler.terminal("failed", error={"code": code, "message": message})
        await self.close()
        return terminal

    async def _finish(self) -> None:
        self.stream = None  # the worker already ended this job
        await self.close()

    async def close(self) -> None:
        """Cancels an unfinished job, then releases admission. Safe to call repeatedly."""
        if self.closed:
            return
        self.closed = True
        pending, self._pending = self._pending, None
        if pending is not None and not pending.done():
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
        stream, self.stream = self.stream, None
        if stream is not None:
            try:
                await stream.aclose()
            except (WorkerGone, RuntimeError):
                pass
        if self.acquired:
            self.acquired = False
            self.runtime.admission.release()
        self.runtime.runs.discard(self)
        self.runtime.counts[self.status] += 1
        name = {"rejected": "response_rejected", "cancelled": "response_cancelled"}
        usage = self.result.get("usage") or {}
        metrics = self.result.get("metrics") or {}
        peak = metrics.get("peak_memory_bytes")
        event(
            name.get(self.status, "response_complete"),
            response_id=self.response_id,
            status=self.status,
            transport=self.transport,
            duration_ms=round((time.monotonic() - self.started) * 1000),
            input_tokens=self.accepted.get("input_tokens"),
            cached_tokens=self.accepted.get("cached_tokens"),
            restore_path=self.accepted.get("restore_path"),
            prefilled_tokens=metrics.get("prefill_tokens"),
            output_tokens=usage.get("output_tokens"),
            reasoning_tokens=(usage.get("output_tokens_details") or {}).get("reasoning_tokens"),
            ttft_ms=metrics.get("first_token_ms"),
            prefill_tok_s=metrics.get("prefill_tok_s"),
            decode_tok_s=metrics.get("decode_tok_s"),
            peak_memory_gb=round(peak / 1024**3, 1) if peak else None,
            queue_ms=self.queue_ms,
            **{
                key: metrics.get(key)
                for key in (
                    "ple_bytes_read",
                    "ple_lookup_ms",
                    "ple_prefetch_ms",
                    "snapshot_count",
                    "snapshot_bytes",
                    "session_bytes",
                    *PRESSURE_FIELDS,
                    "prefill_max_chunk_ms",
                )
            },
        )


_UNSERVED = "The request could not be served."
_REJECTED = {
    "context_length_exceeded": "Input plus reserved output exceeds the model context window.",
}
_FAILED = {
    "server_error": "The server failed while generating.",
    "engine_failure": "The inference engine failed.",
    "structured_output_invalid": "The output did not satisfy the requested schema.",
}
# Fixed explanations for tool_call_invalid (docs/protocol.md 9.2): which kind of breakage,
# never the model's text.
_TOOL_CALL_INVALID = {
    "unclosed": "Tool call markup is not closed.",
    "no_function": "Tool call has no function name.",
    "bad_name": "Tool name does not match the naming rule.",
    "malformed": "Tool call markup is malformed.",
}
