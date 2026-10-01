"""input_image structure (docs/protocol.md 7.1, 11): a port of aporisa_code/src/protocol/images.ts.

The declared format matches the bytes, the header gives a size and the file is complete;
the worker decodes images fully. Kept dependency-free so the gateway checks it cheaply.
"""

from __future__ import annotations

import base64
import binascii
import re
from dataclasses import dataclass

DATA_URL = re.compile(r"^data:image/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$")
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PNG_END = b"IEND\xaeB`\x82"
# start-of-frame markers SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC)
JPEG_FRAMES = frozenset(range(0xC0, 0xD0)) - {0xC4, 0xC8, 0xCC}


@dataclass(frozen=True)
class ImageInfo:
    format: str  # png | jpeg
    width: int
    height: int


def data_bytes(url: str) -> tuple[str, bytes] | None:
    """(declared format, decoded bytes) of a PNG or JPEG base64 data URL, else None."""
    match = DATA_URL.match(url)
    if not match:
        return None
    try:
        return match.group(1), base64.b64decode(match.group(2), validate=True)
    except (binascii.Error, ValueError):
        return None


def _png(data: bytes) -> ImageInfo | None:
    if len(data) < 45 or not data.startswith(PNG_SIGNATURE) or not data.endswith(PNG_END):
        return None
    if int.from_bytes(data[8:12], "big") != 13 or data[12:16] != b"IHDR":
        return None
    width, height = int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    return ImageInfo("png", width, height) if width > 0 and height > 0 else None


def _jpeg(data: bytes) -> ImageInfo | None:
    if len(data) < 4 or data[:2] != b"\xff\xd8" or data[-2:] != b"\xff\xd9":
        return None
    at = 2
    while at + 4 <= len(data):
        if data[at] != 0xFF:
            return None
        marker = data[at + 1]
        if marker == 0xFF:
            at += 1
            continue
        if marker in JPEG_FRAMES:
            if at + 9 > len(data):
                return None
            height = int.from_bytes(data[at + 5 : at + 7], "big")
            width = int.from_bytes(data[at + 7 : at + 9], "big")
            return ImageInfo("jpeg", width, height) if width > 0 and height > 0 else None
        if marker in (0xD9, 0xDA):
            return None
        at += 2 + int.from_bytes(data[at + 2 : at + 4], "big")
    return None


def image_info(url: str) -> ImageInfo | None:
    """The image a data URL holds, or None when it is not a complete PNG or JPEG of the
    declared format (7.1 invalid_image)."""
    decoded = data_bytes(url)
    if decoded is None:
        return None
    declared, data = decoded
    info = _png(data) if declared == "png" else _jpeg(data)
    return info if info is not None and info.format == declared else None


def input_images(items: list[dict]) -> list[tuple[str, dict]]:
    """(parameter path, part) for every input_image, in input order."""
    images: list[tuple[str, dict]] = []
    for index, item in enumerate(items):
        if item["type"] == "message":
            parts, field = item["content"], "content"
        elif item["type"] in ("function_call_output", "custom_tool_call_output"):
            parts, field = item["output"], "output"
        else:
            continue
        if isinstance(parts, list):
            for position, part in enumerate(parts):
                if part["type"] == "input_image":
                    images.append((f"input[{index}].{field}[{position}]", part))
    return images
