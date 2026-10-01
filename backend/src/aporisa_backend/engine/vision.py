"""Image input (B2-6): sizing, decoding, preprocessing, encoding and M-RoPE positions.

An image becomes `<|vision_start|>` + N `<|image_pad|>` + `<|vision_end|>` in the prompt;
the vision tower's features replace the pad embeddings, and the pads take 3D positions
(time, row, column) instead of consecutive ones, so text after an image continues from the
image's largest position + 1 rather than from its token count (qwen3_5 get_rope_index).

Sizing follows the model's processor (mlx-vlm's numpy port of the Qwen2/3-VL one, the same
code mlx-vlm serves this model with): the image is resized, keeping its aspect ratio, to
multiples of 32 pixels between a minimum and the `detail` cap; one token per 32x32 pixels.
Unlike the reference processor, EXIF orientation is applied first, so a photo is seen the
way it is shown.

Every pad token id is the same, whatever the image. Caches compare token sequences, so the
first pad of each image is replaced in the session's key sequence by a negative id derived
from the image's digest: two different images never share a cached prefix (memory or SSD),
while the model is fed the real ids.
"""

from __future__ import annotations

import hashlib
import io
import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from ..protocol.images import data_bytes

VISION_START, VISION_END, IMAGE_PAD, VIDEO_PAD = 248053, 248054, 248056, 248057
VISION_IDS = frozenset({VISION_START, VISION_END, IMAGE_PAD, VIDEO_PAD})
_ROTATED = {5, 6, 7, 8}  # EXIF orientations that swap width and height


class ImageError(Exception):
    """An image the worker cannot use (protocol 9.1 invalid_image); names the part."""

    def __init__(self, param: str):
        super().__init__(param)
        self.param = param


@dataclass(frozen=True)
class ImagePolicy:
    """Resolution caps (profile, B2-6 decision 1) and the model's processor geometry."""

    min_pixels: int
    max_pixels: dict  # detail -> pixel cap
    max_source_pixels: int
    patch_size: int = 16
    merge_size: int = 2
    temporal_patch_size: int = 2
    image_mean: tuple[float, ...] = (0.5, 0.5, 0.5)
    image_std: tuple[float, ...] = (0.5, 0.5, 0.5)

    @classmethod
    def load(cls, model_dir: Path, images: dict) -> ImagePolicy:
        config = json.loads((Path(model_dir) / "preprocessor_config.json").read_text())
        return cls(
            min_pixels=int(images["min_pixels"]),
            max_pixels={k: int(v) for k, v in images["max_pixels"].items()},
            max_source_pixels=int(images["max_source_pixels"]),
            patch_size=int(config["patch_size"]),
            merge_size=int(config["merge_size"]),
            temporal_patch_size=int(config["temporal_patch_size"]),
            image_mean=tuple(config["image_mean"]),
            image_std=tuple(config["image_std"]),
        )

    def processor(self, detail: str):
        from mlx_vlm.models.qwen3_vl.processing_qwen3_vl import Qwen3VLImageProcessor

        return Qwen3VLImageProcessor(
            patch_size=self.patch_size,
            temporal_patch_size=self.temporal_patch_size,
            merge_size=self.merge_size,
            min_pixels=self.min_pixels,
            max_pixels=self.max_pixels[detail],
            image_mean=list(self.image_mean),
            image_std=list(self.image_std),
        )


@dataclass(frozen=True)
class ImageSpec:
    """One input image, sized but not decoded."""

    param: str
    data: bytes = field(repr=False)
    detail: str
    width: int  # as shown (EXIF orientation applied)
    height: int
    grid_h: int  # in tokens (after the 2x2 merge)
    grid_w: int
    digest: bytes

    @property
    def tokens(self) -> int:
        return self.grid_h * self.grid_w

    @property
    def key(self) -> int:
        """The negative id standing for this image in key sequences (int32 range)."""
        return -1 - int.from_bytes(self.digest[:4], "little") % (2**31 - 1)


def describe(part: dict, param: str, policy: ImagePolicy) -> ImageSpec:
    """Size and identity of an input_image from its header (no pixel decode)."""
    from PIL import Image, UnidentifiedImageError

    decoded = data_bytes(part["image_url"])
    if decoded is None:
        raise ImageError(param)
    declared, data = decoded
    detail = part.get("detail") or "auto"
    try:
        with Image.open(io.BytesIO(data)) as image:
            if (image.format or "").lower() != declared:
                raise ImageError(param)
            width, height = image.size
            if image.getexif().get(0x0112) in _ROTATED:
                width, height = height, width
    except (OSError, UnidentifiedImageError, ValueError, Image.DecompressionBombError):
        raise ImageError(param) from None
    if width * height > policy.max_source_pixels:
        raise ImageError(param)
    try:
        resized_h, resized_w = policy.processor(detail)._resolved_size(height, width)
    except ValueError:  # aspect ratio beyond 200:1
        raise ImageError(param) from None
    unit = policy.patch_size * policy.merge_size
    digest = hashlib.sha256(f"{detail}:{resized_h}x{resized_w}|".encode() + data).digest()
    return ImageSpec(
        param, data, detail, width, height, resized_h // unit, resized_w // unit, digest
    )


def decode(spec: ImageSpec, policy: ImagePolicy) -> np.ndarray:
    """Pixels as (3, H, W) uint8, EXIF orientation applied; ImageError when the file does
    not decode completely. PIL decodes damaged PNG data leniently; verify() checks every
    chunk's CRC first (it consumes the file, so the image is opened again to decode)."""
    from PIL import Image, ImageOps

    Image.MAX_IMAGE_PIXELS = policy.max_source_pixels
    try:
        with Image.open(io.BytesIO(spec.data)) as image:
            image.verify()
        with Image.open(io.BytesIO(spec.data)) as image:
            image.load()
            upright = ImageOps.exif_transpose(image).convert("RGB")
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError):
        raise ImageError(spec.param) from None
    if upright.size != (spec.width, spec.height):
        raise ImageError(spec.param)
    return np.transpose(np.asarray(upright), (2, 0, 1))


def preprocess(spec: ImageSpec, policy: ImagePolicy) -> tuple[np.ndarray, np.ndarray]:
    """(pixel_values [patches, C*T*P*P] float32, grid_thw [1, 3]) for the vision tower."""
    out = policy.processor(spec.detail)(images=[decode(spec, policy)])
    grid = out["image_grid_thw"]
    merge = policy.merge_size
    if int(grid[0, 1]) // merge != spec.grid_h or int(grid[0, 2]) // merge != spec.grid_w:
        raise ImageError(spec.param)  # cannot happen when header and pixels agree
    return out["pixel_values"], grid


def positions(length: int, images: list[tuple[int, ImageSpec]]) -> tuple[np.ndarray, int]:
    """M-RoPE position ids [3, length] for a sequence with images at (start, spec), and the
    shift (next position - length) that positions every later token."""
    out = np.empty((3, length), dtype=np.int32)
    cursor = position = 0
    for start, spec in sorted(images, key=lambda pair: pair[0]):
        text = start - cursor
        out[:, cursor:start] = position + np.arange(text, dtype=np.int32)
        position += text
        h, w = spec.grid_h, spec.grid_w
        out[0, start : start + h * w] = position
        out[1, start : start + h * w] = position + np.repeat(np.arange(h, dtype=np.int32), w)
        out[2, start : start + h * w] = position + np.tile(np.arange(w, dtype=np.int32), h)
        position += max(h, w)
        cursor = start + h * w
    out[:, cursor:] = position + np.arange(length - cursor, dtype=np.int32)
    position += length - cursor
    return out, position - length


class VisionEncoder:
    """The model's vision tower: pixels -> one feature row per image token."""

    def __init__(self, vision_tower, policy: ImagePolicy):
        self.tower, self.policy = vision_tower, policy

    def encode(self, spec: ImageSpec):
        import mlx.core as mx

        pixels, grid = preprocess(spec, self.policy)
        dtype = self.tower.patch_embed.proj.weight.dtype
        features, _ = self.tower(mx.array(pixels).astype(dtype), mx.array(grid))
        mx.eval(features)
        if features.shape[0] != spec.tokens:
            raise ValueError("vision features do not match the image tokens")
        return features
