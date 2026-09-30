"""Private gateway <-> worker framing (DEVELOPMENT_PLAN.md 14.3).

A frame is a 4-byte big-endian length followed by that many bytes of UTF-8 JSON (one
object). The channel is an inherited socketpair, never a port or a file. Large state (KV,
snapshots) never crosses it; the biggest payload is a full request (HTTP body limit 16 MiB).
"""

from __future__ import annotations

import asyncio
import json
import socket
import struct
import threading

MAX_FRAME_BYTES = 20 * 1024 * 1024
HEADER = struct.Struct(">I")


class FrameError(Exception):
    """The peer broke the framing: oversized, truncated or non-object frame."""


def encode(message: dict) -> bytes:
    body = json.dumps(message, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    data = body.encode()
    if len(data) > MAX_FRAME_BYTES:
        raise FrameError("frame exceeds the size limit")
    return HEADER.pack(len(data)) + data


def decode(body: bytes) -> dict:
    try:
        message = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise FrameError("frame is not JSON") from error
    if not isinstance(message, dict):
        raise FrameError("frame is not a JSON object")
    return message


def _length(header: bytes) -> int:
    (length,) = HEADER.unpack(header)
    if length > MAX_FRAME_BYTES:
        raise FrameError("frame exceeds the size limit")
    return length


async def read_frame(reader: asyncio.StreamReader) -> dict | None:
    """The next message, or None on a clean end of stream between frames."""
    try:
        header = await reader.readexactly(HEADER.size)
    except asyncio.IncompleteReadError as error:
        if not error.partial:
            return None
        raise FrameError("truncated frame header") from error
    try:
        body = await reader.readexactly(_length(header))
    except asyncio.IncompleteReadError as error:
        raise FrameError("truncated frame body") from error
    return decode(body)


class Channel:
    """Blocking side of the socketpair (the worker): one reader, many writers."""

    def __init__(self, sock: socket.socket):
        self.sock = sock
        self._write = threading.Lock()

    def send(self, message: dict) -> None:
        data = encode(message)
        with self._write:
            self.sock.sendall(data)

    def _exactly(self, count: int) -> bytes | None:
        chunks, remaining = [], count
        while remaining:
            chunk = self.sock.recv(min(remaining, 1 << 20))
            if not chunk:
                if remaining == count:
                    return None
                raise FrameError("truncated frame")
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def recv(self) -> dict | None:
        """The next message, or None when the peer closed the channel between frames."""
        header = self._exactly(HEADER.size)
        if header is None:
            return None
        length = _length(header)
        body = self._exactly(length) if length else b""
        if body is None:
            raise FrameError("truncated frame body")
        return decode(body)

    def close(self) -> None:
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.sock.close()
