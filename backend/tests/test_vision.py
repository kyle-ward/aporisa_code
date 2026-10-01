"""Image input (B2-6) on the tiny model: positions, prefill, caches, rejection, metrics.

The tiny checkpoint has a one-layer random vision tower; tests compare against mlx-vlm's
own image path (get_input_embeddings, get_rope_index), never against content.
"""

from __future__ import annotations

import base64
import io

import mlx.core as mx
import numpy as np
import pytest
from conftest import ALIAS, request, worker_init

from aporisa_backend.configs.engine import ENGINE
from aporisa_backend.engine import generate as gen
from aporisa_backend.engine.speculative import text_only
from aporisa_backend.engine.vision import IMAGE_PAD, VISION_IDS, ImageError, preprocess

RED, BLUE = (200, 40, 40), (40, 40, 200)


def png_bytes(width: int, height: int, color=RED) -> bytes:
    from PIL import Image

    image = Image.new("RGB", (width, height), color)
    image.paste((255, 255, 255), (0, 0, max(1, width // 4), height))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def url(data: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(data).decode()


def asking(*images: str, text: str = "Describe the picture.", **extra) -> dict:
    content = [{"type": "input_text", "text": text}]
    content += [{"type": "input_image", "image_url": image} for image in images]
    body = request(text, max_output_tokens=4, reasoning={"effort": "none"}, **extra)
    return {**body, "input": [{"type": "message", "role": "user", "content": content}]}


@pytest.fixture(scope="module")
def engine(tiny_model_dir, tiny_draft_dir, tmp_path_factory):
    from aporisa_backend.engine import runtime

    root = tmp_path_factory.mktemp("kv") / "kv-cache"
    init = worker_init(
        tiny_model_dir,
        draft_dir=str(tiny_draft_dir),
        draft_schedule=[[0, 2]],
        kv_cache={"dir": str(root), "identity": "tiny", "draft_identity": "tiny-mtp"},
        engine={**ENGINE.as_dict(), "ssd_block_tokens": 64},
    )
    engine = runtime.load(init)
    runtime.warmup(engine, ALIAS)  # includes an image request
    assert engine.info["image_input"] is True
    return engine


def run(engine, body: dict, session: str | None = None) -> list[dict]:
    messages: list[dict] = []
    engine.generate(
        {"id": "v", "request": body, "session": session}, messages.append, gen.JobFlags()
    )
    return messages


def test_positions_match_mlx_vlm(engine):
    plan = engine.adapter.render(
        asking(url(png_bytes(320, 256)), url(png_bytes(96, 640, BLUE)), text="Two pictures:")
    )
    assert len(plan.images) == 2
    merge = engine.vision.policy.merge_size
    grid = mx.array([[1, spec.grid_h * merge, spec.grid_w * merge] for _, spec in plan.images])
    reference, _ = engine.lm.get_rope_index(mx.array([plan.tokens]), image_grid_thw=grid)
    assert np.array_equal(np.array(reference)[:, 0], plan.positions)


def test_prefill_with_images_matches_mlx_vlm(engine, monkeypatch):
    """One chunk: exactly mlx-vlm's image path (merged embeddings, rope index, one forward).
    Chunks that split the image: the same up to kernel rounding."""
    body = asking(url(png_bytes(320, 256)), text="What is in this picture?")
    plan = engine.adapter.render(body)
    [(start, spec)] = plan.images
    pixels, grid = preprocess(spec, engine.vision.policy)
    model = engine.model_ref
    ids = mx.array([plan.tokens])
    features = model.get_input_embeddings(ids, mx.array(pixels), image_grid_thw=mx.array(grid))
    cache = engine.lm.make_cache()
    out = engine.lm(
        ids,
        inputs_embeds=features.inputs_embeds,
        cache=cache,
        position_ids=features.position_ids,
        return_hidden=True,
        skip_logits=True,
    )
    hidden = out.hidden_states[0]
    reference = engine.lm.lm_head(engine.lm.model.hyper_connection_mixer(hidden[:, -1:]))[0, -1]
    reference = np.array(reference.astype(mx.float32))

    def prefill(chunk: int) -> np.ndarray:
        monkeypatch.setattr(engine.settings, "prefill_chunk", chunk)
        match = engine.sessions.acquire(None, plan.cache_keys)
        engine._prefill(match.session, plan.tokens, [], gen.JobFlags(), 16, plan)
        logits = np.array(match.session.logits.astype(mx.float32))
        engine.sessions.done(match.session)
        return logits

    assert np.array_equal(prefill(4096), reference)
    split = prefill(start + spec.tokens // 2)  # one chunk ends inside the image
    assert np.allclose(split, reference, atol=0.05, rtol=0.05)


def test_caches_tell_images_of_one_size_apart(engine):
    red, blue = url(png_bytes(256, 256)), url(png_bytes(256, 256, BLUE))
    first = run(engine, asking(red), "pictures")
    assert first[0]["restore_path"] == "cold"
    again = run(engine, asking(red), "pictures")[0]
    # the same prompt again: all of it cached (from the prompt-end snapshot, as the session
    # also holds the generated tokens)
    assert again["cached_tokens"] == again["input_tokens"]
    other = run(engine, asking(blue), "pictures")[0]
    plan = engine.adapter.render(asking(blue))
    [(start, _)] = plan.images
    assert other["cached_tokens"] <= start < other["input_tokens"]

    # on SSD too: the red session is written; a blue request finds nothing past the image
    store = engine.sessions
    session = store.sessions["pictures"]
    run(engine, asking(red), "pictures")
    disk = store.disk
    disk.spill(session, engine.drafter)
    red_plan = engine.adapter.render(asking(red))
    assert disk.restore(red_plan.cache_keys, 1, store.make_cache, engine.drafter) is not None
    found = disk.restore(plan.cache_keys, 1, store.make_cache, engine.drafter)
    assert found is None or found.offset <= start
    store.release("pictures")


def test_an_image_that_does_not_decode_is_rejected_before_the_stream(engine):
    data = bytearray(png_bytes(256, 256))
    at = data.index(b"IDAT") + 40  # inside the compressed pixels: header and end intact
    data[at] ^= 0xFF
    messages = run(engine, asking(url(bytes(data))))
    assert messages == [
        {"id": "v", "type": "rejected", "code": "invalid_image", "param": "input[0].content[1]"}
    ]


def test_counting_and_metrics_include_images(engine):
    body = asking(url(png_bytes(512, 384)), url(png_bytes(256, 256, BLUE)))
    messages = run(engine, body)
    accepted, finished = messages[0], messages[-1]
    plan = engine.adapter.render(body)
    assert accepted["input_tokens"] == engine.count(body) == len(plan.tokens)
    metrics = finished["metrics"]
    assert metrics["image_count"] == 2
    assert metrics["image_tokens"] == plan.image_tokens == 192 + 64
    assert metrics["vision_encode_ms"] is not None
    assert plan.tokens.count(IMAGE_PAD) == plan.image_tokens
    with pytest.raises(ImageError):
        engine.count(asking(url(png_bytes(20_000, 40))))  # beyond 200:1


def test_lookup_drafts_stop_at_images():
    assert text_only([5, 6, -77, 8], VISION_IDS) == [5, 6]
    assert text_only([5, IMAGE_PAD, 6], VISION_IDS) == [5]
    assert text_only([5, 6], VISION_IDS) == [5, 6]
