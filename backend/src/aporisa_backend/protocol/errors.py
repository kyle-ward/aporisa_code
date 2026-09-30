"""Error codes of the Aporisa protocol (docs/protocol.md section 9).

Mirrors aporisa_code/src/protocol/errors.ts. Messages are fixed, safe explanations: they
never echo request content, keys, paths or engine output.
"""

from __future__ import annotations

HTTP_ERROR_STATUS: dict[str, tuple[int, str]] = {
    "invalid_request": (400, "invalid_request_error"),
    "unsupported_parameter": (400, "invalid_request_error"),
    "unsupported_schema": (400, "invalid_request_error"),
    "invalid_image": (400, "invalid_request_error"),
    "context_length_exceeded": (400, "invalid_request_error"),
    "invalid_api_key": (401, "authentication_error"),
    "model_not_found": (404, "invalid_request_error"),
    "not_found": (404, "invalid_request_error"),
    "request_timeout": (408, "invalid_request_error"),
    "previous_response_not_found": (409, "invalid_request_error"),
    "response_in_progress": (409, "invalid_request_error"),
    "request_too_large": (413, "invalid_request_error"),
    "unsupported_media_type": (415, "invalid_request_error"),
    "queue_full": (429, "rate_limit_error"),
    "queue_timeout": (429, "rate_limit_error"),
    "internal_error": (500, "server_error"),
    "service_not_ready": (503, "server_error"),
    "connection_limit_reached": (503, "server_error"),
}

# Codes that carry Retry-After (section 9.1) and may be retried before the stream starts.
RETRY_AFTER_CODES = frozenset({"queue_full", "queue_timeout", "service_not_ready"})

# response.failed error codes (section 9.2).
STREAM_ERROR_CODES = frozenset(
    {
        "server_error",
        "inference_timeout",
        "output_limit_exceeded",
        "structured_output_invalid",
        "engine_failure",
        "tool_call_invalid",
    }
)


class ProtocolError(Exception):
    """A pre-stream failure: an HTTP error body, or a WebSocket `error` message."""

    def __init__(self, code: str, message: str, param: str | None = None):
        if code not in HTTP_ERROR_STATUS:
            raise ValueError(f"unknown protocol error code {code!r}")
        super().__init__(message)
        self.code, self.message, self.param = code, message, param

    @property
    def status(self) -> int:
        return HTTP_ERROR_STATUS[self.code][0]

    def body(self) -> dict:
        return {
            "error": {
                "type": HTTP_ERROR_STATUS[self.code][1],
                "code": self.code,
                "message": self.message,
                "param": self.param,
            }
        }

    def ws_message(self) -> dict:
        return {"type": "error", "status": self.status, **self.body()}
