"""WebSocket transport (docs/protocol.md section 3.3, DEVELOPMENT_PLAN.md 14.4).

Per connection: at most one response in flight, the last completed response's full request
and output (so continuation is always expandable here, whatever the worker still caches),
a bounded lifetime, and the worker session `conn:<id>` that is released on disconnect.
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
import time

from starlette.responses import JSONResponse
from starlette.websockets import WebSocket, WebSocketDisconnect

from ..protocol import schema, strict_json
from ..protocol.continuation import expand_continuation, same_properties
from ..protocol.errors import ProtocolError
from .events import new_id
from .runtime import KEEPALIVE


class Connection:
    def __init__(self, gateway, websocket: WebSocket):
        self.gateway, self.ws = gateway, websocket
        self.runtime = gateway.runtime
        self.id = new_id("conn")
        self.session = f"conn:{self.id}"
        self.created = time.monotonic()
        self.run = None
        self.task: asyncio.Task | None = None
        self.last: tuple[str, dict, list] | None = None  # (response id, full params, output)
        self.expired = False
        self.send_lock = asyncio.Lock()

    async def send(self, payload: dict) -> None:
        async with self.send_lock:
            await self.ws.send_text(strict_json.dumps(payload))

    async def error(self, error: ProtocolError) -> None:
        await self.send(error.ws_message())

    @property
    def busy(self) -> bool:
        return self.task is not None and not self.task.done()

    async def expire(self) -> None:
        await self.error(
            ProtocolError("connection_limit_reached", "Connection lifetime reached; reconnect.")
        )
        await self.ws.close()

    async def lifetime(self) -> None:
        await asyncio.sleep(self.gateway.limits.ws_lifetime_s)
        self.expired = True
        if not self.busy:
            await self.expire()

    async def handle(self, raw: str) -> None:
        try:
            message = strict_json.loads(raw)
        except strict_json.StrictJsonError:
            return await self.error(ProtocolError("invalid_request", "Invalid JSON."))
        kind = message.get("type") if isinstance(message, dict) else None
        if kind == "response.interrupt":
            try:
                schema.check("WsInterruptMessage", message)
            except ProtocolError:
                return await self.error(
                    ProtocolError("invalid_request", "Invalid interrupt message.")
                )
            if (
                self.busy
                and self.run is not None
                and self.run.response_id == message["response_id"]
            ):
                self.run.interrupt()
            return None
        if kind != "response.create":
            return await self.error(
                ProtocolError("invalid_request", "Unknown message type.", "type")
            )
        if self.busy:
            return await self.error(
                ProtocolError("response_in_progress", "A response is already in progress.")
            )
        try:
            schema.check("WsCreateMessage", message)
            previous = message.get("previous_response_id")
            params = {k: v for k, v in message.items() if k not in ("type", "previous_response_id")}
            if not params["input"] and previous is None:
                raise ProtocolError(
                    "invalid_request", "input may be empty only with previous_response_id.", "input"
                )
            if previous is not None:
                if (
                    self.last is None
                    or self.last[0] != previous
                    or not same_properties(self.last[1], params)
                ):
                    raise ProtocolError(
                        "previous_response_not_found",
                        "Previous response was not found.",
                        "previous_response_id",
                    )
                params = expand_continuation(self.last[1], self.last[2], params)
            self.runtime.validate(params)
        except ProtocolError as error:
            return await self.error(error)
        self.last = None
        session = params.get("prompt_cache_key") or self.session
        self.run = self.runtime.new_run(params, transport="websocket", session=session)
        self.task = asyncio.create_task(self.respond(self.run))
        return None

    async def respond(self, run) -> None:
        try:
            try:
                await run.open()
            except ProtocolError as error:
                await self.error(error)
                return
            async for item in run.events():
                if item is KEEPALIVE:
                    continue  # WebSocket keepalive is ping/pong at the transport level
                await self.send(item)
                if item["type"] == "response.completed":
                    self.last = (run.response_id, run.params, item["response"]["output"])
        finally:
            await run.close()
            if self.expired:
                try:
                    await self.expire()
                except Exception:  # noqa: BLE001 - the socket may already be gone
                    pass


# uvicorn's websockets-sansio protocol (0.54.0) never marks a denial response as a completed
# handshake, so after a correct 401/404 denial it logs "ASGI callable returned without
# completing handshake." (its 500 fallback is skipped; the client gets our response). The
# filter drops that line only for connections this module denied on purpose.
_DENIED = contextvars.ContextVar("aporisa_ws_denied", default=False)


class _DeniedHandshakeFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return not (_DENIED.get() and "without completing handshake" in record.getMessage())


def install_log_filter() -> None:
    logger = logging.getLogger("uvicorn.error")
    if not any(isinstance(f, _DeniedHandshakeFilter) for f in logger.filters):
        logger.addFilter(_DeniedHandshakeFilter())


async def _deny(websocket: WebSocket, error: ProtocolError, headers: dict | None = None) -> None:
    _DENIED.set(True)
    await websocket.send_denial_response(
        JSONResponse(error.body(), status_code=error.status, headers=headers)
    )


async def serve_websocket(gateway, scope, receive, send) -> None:
    websocket = WebSocket(scope, receive, send)
    runtime = gateway.runtime
    if scope["path"] != "/v1/responses" or not runtime.model["capabilities"]["websocket"]:
        return await _deny(websocket, ProtocolError("not_found", "Unknown endpoint."))
    if not gateway.authorized(scope):
        return await _deny(
            websocket,
            ProtocolError("invalid_api_key", "Invalid API key."),
            {"www-authenticate": "Bearer"},
        )
    await websocket.accept()
    connection = Connection(gateway, websocket)
    lifetime = asyncio.create_task(connection.lifetime())
    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            if message.get("text") is None:
                await connection.error(
                    ProtocolError("invalid_request", "Binary frames are not supported.")
                )
                continue
            if len(message["text"].encode()) > gateway.limits.ws_max_message_bytes:
                await connection.error(ProtocolError("request_too_large", "Message is too large."))
                continue
            await connection.handle(message["text"])
    except WebSocketDisconnect:
        pass
    finally:
        lifetime.cancel()
        if connection.task is not None and not connection.task.done():
            connection.task.cancel()
        tasks = [t for t in (connection.task, lifetime) if t is not None]
        await asyncio.gather(*tasks, return_exceptions=True)
        if connection.run is not None:
            await connection.run.close()
        if runtime.worker is not None:
            try:
                await runtime.worker.release_session(connection.session)
            except Exception:  # noqa: BLE001 - the worker may be restarting
                pass
