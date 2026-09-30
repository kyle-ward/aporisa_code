"""Worker startup: memory limits, offline load, PLE prefetch, warmup (14.5).

Order matters (B0): raise the MLX wired limit before loading, otherwise macOS compresses and
swaps the resident weights and prefill collapses by an order of magnitude.
"""

from __future__ import annotations

import os
import secrets
from pathlib import Path

import mlx.core as mx

from ..configs.engine import EngineConfig
from .adapters.qwen38 import Qwen38Adapter, TokenMap
from .generate import Engine, JobFlags, Settings
from .ple_prefetch import PlePrefetcher, external_ple
from .sessions import SessionStore
from .tokens import Codec

ADAPTERS = {"qwen38_flash_next": Qwen38Adapter}


class WarmupError(Exception):
    pass


def load(init: dict) -> Engine:
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
    config = EngineConfig(**init["engine"])
    model_dir = Path(init["model_dir"])
    wired = int(mx.device_info()["max_recommended_working_set_size"])
    mx.set_wired_limit(wired)
    mx.set_cache_limit(config.cache_limit_bytes)

    from mlx_vlm.utils import load_model

    model = load_model(model_dir, lazy=True)
    lm = model.language_model
    released = materialize(model, model_dir)
    weights = int(mx.get_active_memory())
    adapter = ADAPTERS[init["adapter"]](Codec(model_dir), init["model"])
    prefetcher = PlePrefetcher(lm, config.ple_threads) if external_ple(lm) else None
    budget = init.get("snapshot_budget_bytes")
    if budget is None:
        budget = session_budget(wired, weights, config)
    sessions = SessionStore(
        lm.make_cache,
        budget_bytes=budget,
        kv_bytes_per_token=int(init["kv_bytes_per_token"]),
        max_snapshots=config.max_snapshots,
    )
    engine = Engine(
        lm,
        adapter,
        sessions,
        TokenMap(),
        Settings(
            context_window=init["model"]["context_window"],
            max_output_tokens=init["model"]["max_output_tokens"],
            prefill_chunk=config.prefill_chunk,
        ),
        prefetcher,
    )
    engine.info = {
        "wired_limit_bytes": wired,
        "weights_bytes": weights,
        "snapshot_budget_bytes": sessions.budget_bytes,
        "ple_prefetch": prefetcher is not None,
        "released_cache_bytes": released,
    }
    engine.model_ref = model  # keeps the vision tower and config alive with the process
    return engine


def session_budget(wired: int, weights: int, config: EngineConfig):
    """The session budget as a function of the machine's state right now (configs/engine.py).

    available (free + reclaimable) + what sessions and the MLX buffer cache already hold is
    what the model could use without taking memory from other programs; the reserves keep
    room for activations, the buffer cache and the desktop's own growth.
    """
    import psutil

    ceiling = wired - weights - config.activation_reserve_bytes - config.safety_margin_bytes

    def budget(store: SessionStore) -> int:
        headroom = (
            psutil.virtual_memory().available
            + store.total_bytes()
            + mx.get_cache_memory()
            - config.activation_reserve_bytes
            - config.cache_limit_bytes
            - config.desktop_margin_bytes
        )
        return min(ceiling, headroom)

    return budget


def materialize(model, model_dir: Path) -> int:
    """Reads the lazily loaded weights into GPU buffers one decoder layer at a time.

    Every weight file is read through the page cache. Loading everything at once briefly
    needs the weights twice (cached file pages plus GPU buffers), more than the machine has,
    and the kernel answers with a burst of compression that stalls the desktop (P4: ~56 GiB
    compressed and decompressed during one start). Releasing each layer's file pages right
    after the layer is evaluated keeps the cache to about one layer. Returns the bytes still
    cached at the end, released as well.
    """
    import json
    from collections import defaultdict

    from ..pagecache import release_all

    weight_map = json.loads((model_dir / "model.safetensors.index.json").read_text())["weight_map"]
    per_layer: dict[int, set[Path]] = defaultdict(set)
    for name, file in weight_map.items():
        if ".model.layers." in name:
            per_layer[int(name.split(".model.layers.")[1].split(".")[0])].add(model_dir / file)
    release_all({model_dir / file for file in weight_map.values()})
    for index, layer in enumerate(model.language_model.model.layers):
        mx.eval(layer.parameters())
        release_all(per_layer.get(index, ()))
    mx.eval(model.parameters())  # embeddings, head, norms, vision tower
    return release_weight_cache(model_dir)


def release_weight_cache(model_dir: Path) -> int:
    """Releases the page cache of the loaded weight files; returns the bytes that were cached."""
    import json

    from ..pagecache import release_all, resident_bytes

    index = json.loads((model_dir / "model.safetensors.index.json").read_text())
    files = sorted({model_dir / name for name in index["weight_map"].values()})
    cached = 0
    for path in files:
        try:
            cached += resident_bytes(path)
        except OSError:
            pass
    release_all(files)
    return cached


def ple_cached_bytes(engine: Engine) -> int | None:
    """Page-cache residency of the files the external PLE table reads (whole files)."""
    from ..pagecache import resident_bytes

    if engine.prefetcher is None:
        return None
    shards = engine.prefetcher.table._shards
    files = {array.filename for _, _, arrays in shards for array in arrays.values()}
    total = 0
    for name in files:
        try:
            total += resident_bytes(Path(name))
        except OSError:
            return None
    return total


def _run(engine: Engine, request: dict, session: str | None = None) -> list[dict]:
    messages: list[dict] = []
    engine.generate(
        {"id": "warmup", "request": request, "session": session}, messages.append, JobFlags()
    )
    return messages


def _terminal(messages: list[dict], what: str) -> dict:
    if not messages or messages[0]["type"] != "accepted":
        raise WarmupError(f"{what}: not accepted")
    last = messages[-1]
    if last["type"] not in ("finished", "failed"):
        raise WarmupError(f"{what}: no terminal message")
    return last


def warmup(engine: Engine, alias: str) -> None:
    """Exercises every path a request can take, before the gateway reports ready."""

    def user(text: str) -> dict:
        return {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": text}],
        }

    base = {"model": alias, "stream": True}
    _terminal(
        _run(
            engine,
            {
                **base,
                "input": [user("Reply with OK.")],
                "max_output_tokens": 8,
                "reasoning": {"effort": "none"},
            },
        ),
        "text generation",
    )
    tools = [
        {
            "type": "function",
            "name": "read_file",
            "description": "Read a file.",
            "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
        }
    ]
    history = [
        user("Read README.md."),
        {
            "type": "function_call",
            "call_id": "w1",
            "name": "read_file",
            "arguments": '{"path": "README.md"}',
        },
        {"type": "function_call_output", "call_id": "w1", "output": "# Readme"},
    ]
    _terminal(
        _run(engine, {**base, "tools": tools, "input": history, "max_output_tokens": 4}),
        "tool rendering",
    )
    session = f"warmup:{secrets.token_hex(4)}"
    prompt = {**base, "input": [user("Warm the cache.")], "max_output_tokens": 4}
    warm = _terminal(_run(engine, {**prompt, "generate": False}, session), "prewarm")
    if warm["type"] != "finished" or warm["usage"]["output_tokens"] != 0:
        raise WarmupError("prewarm: unexpected result")
    again = _run(engine, prompt, session)
    _terminal(again, "continuation")
    accepted = again[0]
    if accepted["restore_path"] != "live" or accepted["cached_tokens"] != accepted["input_tokens"]:
        raise WarmupError("continuation: the prewarmed cache was not reused")
    rejected = _run(
        engine, {**base, "input": [user("x")], "max_output_tokens": engine.settings.context_window}
    )
    if [m["type"] for m in rejected] != ["rejected"]:
        raise WarmupError("context check: an oversized request was not rejected")
    engine.sessions.release(session)
    mx.clear_cache()
    mx.reset_peak_memory()
