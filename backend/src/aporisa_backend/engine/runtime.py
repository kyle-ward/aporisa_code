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
from .disk_cache import DiskCache
from .generate import Engine, JobFlags, Settings
from .ple_prefetch import PlePrefetcher, external_ple
from .sessions import SessionStore
from .speculative import MtpDrafter
from .structured import Structured
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
    drafter = load_drafter(model, Path(init["draft_dir"])) if init.get("draft_dir") else None
    weights = int(mx.get_active_memory())
    locked = lock_weights(model, *([drafter.model] if drafter is not None else []))
    adapter = ADAPTERS[init["adapter"]](Codec(model_dir), init["model"])
    prefetcher = PlePrefetcher(lm, config.ple_threads) if external_ple(lm) else None
    budget = init.get("snapshot_budget_bytes")
    if budget is None:
        budget = session_budget(wired, weights, config)
    kv_bytes = int(init["kv_bytes_per_token"])
    if drafter is not None:
        kv_bytes += int(init["draft_kv_bytes_per_token"])
    sessions = SessionStore(
        lm.make_cache,
        budget_bytes=budget,
        kv_bytes_per_token=kv_bytes,
        max_snapshots=config.max_snapshots,
        drafter=drafter,
        disk=open_disk_cache(init, config),
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
            draft_schedule=tuple(tuple(step) for step in init.get("draft_schedule") or ())
            if drafter is not None
            else ((0, 0),),
            lookup_schedule=tuple(tuple(step) for step in init.get("lookup_schedule") or ())
            or ((0, 0),),
            verify_prefill_schedule=tuple(
                tuple(step) for step in init.get("verify_prefill_schedule") or ()
            )
            or ((0, 0),),
            lookup_min_match=config.lookup_min_match,
            lookup_max_match=config.lookup_max_match,
            lookup_cooldown=config.lookup_cooldown,
            lookup_trust_match=config.lookup_trust_match,
        ),
        prefetcher,
        drafter,
        Structured(model_dir, int(lm.args.vocab_size))
        if init["model"]["capabilities"].get("structured_output")
        else None,
    )
    engine.info = {
        "wired_limit_bytes": wired,
        "weights_bytes": weights,
        "snapshot_budget_bytes": sessions.budget_bytes,
        "ple_prefetch": prefetcher is not None,
        "draft_schedule": [list(step) for step in engine.settings.draft_schedule],
        "lookup_schedule": [list(step) for step in engine.settings.lookup_schedule],
        "released_cache_bytes": released,
        "locked_bytes": locked,
        "ssd_cache": sessions.disk is not None,
    }
    engine.model_ref = model  # keeps the vision tower and config alive with the process
    return engine


def open_disk_cache(init: dict, config: EngineConfig) -> DiskCache | None:
    """The SSD session cache (B2-1) when the gateway names its directory. Its layout is
    every input that decides what a cached state means: the model and draft identities and
    the MLX versions computing them (disk_cache.py adds the format and block size)."""
    spec = init.get("kv_cache")
    if not spec:
        return None
    from importlib.metadata import version

    layout = {
        "model": spec["identity"],
        "draft": spec.get("draft_identity") if init.get("draft_dir") else None,
        "adapter": init["adapter"],
        "mlx": version("mlx"),
        "mlx_vlm": version("mlx-vlm"),
    }
    return DiskCache(
        Path(spec["dir"]),
        layout,
        capacity_bytes=config.ssd_cache_bytes,
        block_tokens=config.ssd_block_tokens,
    )


def lock_weights(*modules) -> int:
    """Wires every weight buffer at the VM level (mlock); returns the bytes locked.

    MLX's wired limit keeps buffers resident while the GPU works, but after ~10 idle hours
    the system had un-wired the model and compressed 53 GB of it into a compressor that
    could not shrink 4-bit weights (stored 53.5 GB in 53.3 GB): no memory freed, pressure
    held at warn, swap written, and the next request would decompress it all (B2). Locked
    pages are never compressed or swapped; the user keeps the rest of the machine for the
    desktop and stops the service to get the memory back. Failure fails the startup.
    """
    import ctypes
    import ctypes.util
    import os

    import numpy as np
    from mlx.utils import tree_flatten

    libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
    libc.mlock.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
    unsigned = {1: mx.uint8, 2: mx.uint16, 4: mx.uint32, 8: mx.uint64}
    locked = 0
    for module in modules:
        for _, array in tree_flatten(module.parameters()):
            # bfloat16 has no buffer-protocol format; a same-size integer view shares memory.
            view = array.view(unsigned[array.dtype.size]) if array.dtype.size in unsigned else array
            mx.eval(view)
            address = np.asarray(memoryview(view)).ctypes.data
            if libc.mlock(ctypes.c_void_p(address), ctypes.c_size_t(array.nbytes)) != 0:
                error = ctypes.get_errno()
                raise OSError(error, f"cannot lock the model weights: {os.strerror(error)}")
            locked += array.nbytes
    return locked


def load_drafter(model, draft_dir: Path) -> MtpDrafter:
    """The MTP draft model (1.4 GiB on affine4g64), bound to the target's embeddings and head.

    Read eagerly like the target, then its file pages are released: the page cache would
    otherwise hold a second copy.
    """
    from mlx_vlm.speculative.drafters import load_drafter as load
    from mlx_vlm.speculative.drafters.qwen4_exp_mtp import Qwen4ExpMTPDraftModel

    from ..pagecache import release_all

    draft, _kind = load(str(draft_dir), kind="mtp")
    if not isinstance(draft, Qwen4ExpMTPDraftModel):
        raise ValueError("the draft model is not a Qwen4-Exp MTP head")
    draft.validate_target_compatibility(model)
    draft.bind(model)
    mx.eval(draft.parameters())
    release_all(set(draft_dir.glob("*.safetensors")))
    return MtpDrafter(draft)


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
    text = _terminal(
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
    if (
        engine.drafter is not None
        and text["type"] == "finished"
        and text["usage"]["output_tokens"] > 1
        and engine.metrics.get("mtp_accept_rate") is None
        and engine.metrics.get("lookup_accept_rate") is None
    ):
        raise WarmupError("speculative decoding: no drafts were verified")
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
    if engine.structured is not None:
        schema = {
            "type": "object",
            "properties": {"ok": {"type": "boolean"}},
            "required": ["ok"],
        }
        answer = _terminal(
            _run(
                engine,
                {
                    **base,
                    "input": [user("Is water wet?")],
                    "max_output_tokens": 16,
                    "reasoning": {"effort": "none"},
                    "text": {
                        "format": {
                            "type": "json_schema",
                            "name": "w",
                            "schema": schema,
                            "strict": True,
                        }
                    },
                },
            ),
            "structured output",
        )
        if answer["type"] != "finished":
            raise WarmupError("structured output: the constrained answer failed")
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
