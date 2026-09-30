"""The public ASGI application (docs/protocol.md sections 3-4, DEVELOPMENT_PLAN.md 14.4).

A small hand-routed ASGI app rather than a framework router, so the order of checks is
exactly the protocol's: unknown non-/v1 paths are 404 before authentication, /v1 requires
Bearer authentication before routing, bodies are bounded before they are read, and every
error has the protocol's shape. No OpenAPI or docs routes exist.
"""

from __future__ import annotations

import asyncio
import hmac
import secrets
import time
from urllib.parse import unquote

from anyio import CancelScope

from ..configs.limits import LIMITS, ServiceLimits
from ..protocol import schema, strict_json
from ..protocol.errors import RETRY_AFTER_CODES, ProtocolError
from .runtime import KEEPALIVE, Runtime
from .websocket import install_log_filter, serve_websocket

PUBLIC_HEALTH = {"/health/live", "/health/ready"}


def _headers(
    request_id: str, content_type: bytes = b"application/json"
) -> list[tuple[bytes, bytes]]:
    return [
        (b"content-type", content_type),
        (b"cache-control", b"no-store"),
        (b"x-request-id", request_id.encode()),
    ]


async def send_json(send, status: int, body: dict, request_id: str, extra=()) -> None:
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": _headers(request_id) + list(extra),
        }
    )
    await send({"type": "http.response.body", "body": strict_json.dumps(body).encode()})


async def send_error(send, error: ProtocolError, request_id: str, limits: ServiceLimits) -> None:
    extra = []
    if error.code in RETRY_AFTER_CODES:
        extra.append((b"retry-after", str(limits.retry_after_s).encode()))
    if error.code == "invalid_api_key":
        extra.append((b"www-authenticate", b"Bearer"))
    await send_json(send, error.status, error.body(), request_id, extra)


def header(scope, name: bytes) -> str | None:
    for key, value in scope.get("headers", []):
        if key.lower() == name:
            return value.decode("latin-1")
    return None


class Gateway:
    def __init__(self, runtime: Runtime, api_key: str, limits: ServiceLimits = LIMITS):
        self.runtime, self.api_key, self.limits = runtime, api_key, limits
        self.http_tasks = 0

    # --- ASGI entry -------------------------------------------------------------------------

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] == "lifespan":
            await self._lifespan(receive, send)
        elif scope["type"] == "http":
            await self._http(scope, receive, send)
        elif scope["type"] == "websocket":
            await serve_websocket(self, scope, receive, send)

    async def _lifespan(self, receive, send) -> None:
        while True:
            message = await receive()
            if message["type"] == "lifespan.startup":
                try:
                    await self.runtime.start()
                except Exception:
                    await send({"type": "lifespan.startup.failed", "message": "startup failed"})
                    return
                await send({"type": "lifespan.startup.complete"})
            elif message["type"] == "lifespan.shutdown":
                await self.runtime.close()
                await send({"type": "lifespan.shutdown.complete"})
                return

    def authorized(self, scope) -> bool:
        value = header(scope, b"authorization") or ""
        expected = f"Bearer {self.api_key}"
        return hmac.compare_digest(value.encode(), expected.encode())

    # --- HTTP -------------------------------------------------------------------------------

    async def _http(self, scope, receive, send) -> None:
        request_id = "req_" + secrets.token_hex(16)
        if self.http_tasks >= self.limits.max_http_tasks:
            await send_error(
                send, ProtocolError("queue_full", "HTTP capacity is full."), request_id, self.limits
            )
            return
        self.http_tasks += 1
        try:
            await self._route(scope, receive, send, request_id)
        except ProtocolError as error:
            await send_error(send, error, request_id, self.limits)
        finally:
            self.http_tasks -= 1

    async def _route(self, scope, receive, send, request_id: str) -> None:
        method, path = scope["method"], scope["path"]
        runtime = self.runtime
        if method == "GET" and path == "/health/live":
            return await send_json(send, 200, {"status": "alive"}, request_id)
        if method == "GET" and path == "/health/ready":
            ready = runtime.ready()
            return await send_json(
                send,
                200 if ready else 503,
                {"status": "ready" if ready else "not_ready"},
                request_id,
            )
        if path == "/health/runtime" and method == "GET":
            if not self.authorized(scope):
                raise ProtocolError("invalid_api_key", "Invalid API key.")
            return await send_json(send, 200, await runtime.status(), request_id)
        if not path.startswith("/v1/"):
            raise ProtocolError("not_found", "Unknown endpoint.")
        if not self.authorized(scope):
            raise ProtocolError("invalid_api_key", "Invalid API key.")
        if method == "GET" and path == "/v1/models":
            return await send_json(
                send, 200, {"object": "list", "data": [runtime.model]}, request_id
            )
        if method == "GET" and path.startswith("/v1/models/"):
            if unquote(path[len("/v1/models/") :]) != runtime.alias:
                raise ProtocolError("model_not_found", "Model not found.", "model")
            return await send_json(send, 200, runtime.model, request_id)
        if method == "POST" and path == "/v1/responses":
            return await self._create(scope, receive, send, request_id)
        if (
            method == "POST"
            and path == "/v1/responses/input_tokens"
            and runtime.model["capabilities"]["input_tokens"]
        ):
            return await self._input_tokens(scope, receive, send, request_id)
        raise ProtocolError("not_found", "Unknown endpoint.")

    async def _read_json(self, scope, receive):
        if header(scope, b"content-encoding"):
            raise ProtocolError("unsupported_media_type", "Compressed bodies are not supported.")
        content_type = (header(scope, b"content-type") or "").lower().replace(" ", "")
        if content_type not in ("application/json", "application/json;charset=utf-8"):
            raise ProtocolError("unsupported_media_type", "Body must be application/json.")
        declared = header(scope, b"content-length")
        if declared and declared.isdigit() and int(declared) > self.limits.max_body_bytes:
            raise ProtocolError("request_too_large", "Request body is too large.")
        chunks, size = [], 0
        deadline = time.monotonic() + self.limits.upload_timeout_s
        while True:
            try:
                message = await asyncio.wait_for(receive(), max(deadline - time.monotonic(), 0.001))
            except TimeoutError:
                raise ProtocolError(
                    "request_timeout", "The request body arrived too slowly."
                ) from None
            if message["type"] == "http.disconnect":
                raise asyncio.CancelledError
            chunk = message.get("body", b"")
            size += len(chunk)
            if size > self.limits.max_body_bytes:
                raise ProtocolError("request_too_large", "Request body is too large.")
            chunks.append(chunk)
            if not message.get("more_body", False):
                break
        try:
            return strict_json.loads(b"".join(chunks))
        except strict_json.StrictJsonError:
            raise ProtocolError("invalid_request", "The body is not strict JSON.") from None

    async def _create(self, scope, receive, send, request_id: str) -> None:
        body = await self._read_json(scope, receive)
        if isinstance(body, dict) and "previous_response_id" in body:
            raise ProtocolError(
                "unsupported_parameter",
                "previous_response_id is only valid on WebSocket.",
                "previous_response_id",
            )
        schema.check("HttpCreateRequest", body)
        params = {key: value for key, value in body.items() if key != "stream"}
        self.runtime.validate(params)
        run = self.runtime.new_run(params, transport="http", session=params.get("prompt_cache_key"))
        await run.open()
        await self._stream_sse(run, receive, send, request_id)

    async def _stream_sse(self, run, receive, send, request_id: str) -> None:
        async def produce() -> None:
            await send(
                {
                    "type": "http.response.start",
                    "status": 200,
                    "headers": _headers(request_id, b"text/event-stream"),
                }
            )
            async for item in run.events():
                if item is KEEPALIVE:
                    chunk = b": keepalive\n\n"
                else:
                    chunk = f"event: {item['type']}\ndata: {strict_json.dumps(item)}\n\n".encode()
                await send({"type": "http.response.body", "body": chunk, "more_body": True})
            await send({"type": "http.response.body", "body": b""})

        async def disconnected() -> None:
            while (await receive())["type"] != "http.disconnect":
                pass

        producer = asyncio.ensure_future(produce())
        watcher = asyncio.ensure_future(disconnected())
        try:
            await asyncio.wait({producer, watcher}, return_when=asyncio.FIRST_COMPLETED)
            if producer.done():
                producer.result()
        finally:
            with CancelScope(shield=True):
                for task in (producer, watcher):
                    if not task.done():
                        task.cancel()
                await asyncio.gather(producer, watcher, return_exceptions=True)
                await run.close()

    async def _input_tokens(self, scope, receive, send, request_id: str) -> None:
        body = await self._read_json(scope, receive)
        schema.check("InputTokensRequest", body)
        self.runtime.validate(body)
        count = await self.runtime.count_tokens(body)
        await send_json(
            send, 200, {"object": "response.input_tokens", "input_tokens": count}, request_id
        )


def create_app(runtime: Runtime, api_key: str, limits: ServiceLimits = LIMITS) -> Gateway:
    install_log_filter()
    return Gateway(runtime, api_key, limits)
