"""Session spill to SSD and restore after eviction or restart (B2-1, P4).

What a session at offset p needs is its KV (target and draft model, append-only) and, at p
exactly, the recurrent states, the logits after token p-1 and the drafter's hidden state.
On disk that is two kinds of files, both content-addressed by hashes of the tokens:

  blocks/<H_i>.blk       KV of tokens [(i-1)B, iB) for every attention layer, B = 2048;
                         H_i = sha256(H_{i-1} || tokens of block i), H_0 from the layout
  checkpoints/<C>.ckpt   the state at p: recurrent states, logits, drafter hidden, and the
                         KV tail [kB, p) after the last full block; C = sha256(H_k || tail)

The drafter's KV entry at position t pairs token t+1 with the target hidden state at t, so
it depends on tokens 0..t+1: block i holds the drafter entries [iB-B-1, iB-1), whose
tokens all lie inside H_i's chain. A checkpoint lists its block hashes; the token list
itself is never written: a request that matches H_1..H_k and the tail hash brings its own
tokens. Blocks are shared by every checkpoint with the same prefix, so a session spilled
again writes only the blocks it gained.

Written when a session leaves memory for the budget or for memory pressure, and at a
graceful stop (B2 decision 5); each spill keeps two checkpoints, the session's end and its
latest snapshot (the prompt end, where a retry or a re-rendered history diverges). Read
when a request's prefix on disk is at least one block longer than what memory holds. Every
file carries a sha256 of its contents, checked on every read; anything that does not check
out is deleted and the request falls back to prefill (P4 decision 1). Written pages are
synced and read pages released from the page cache: the model's memory has no room for a
second copy (B1 P4). Total size is capped (configs/engine.py); the least recently used
checkpoints go first, then blocks no checkpoint references.

The directory is per layout (format, model and draft identities, MLX versions, block
size): anything else is never read and is deleted at the next start. Like the sessions it
extends, the cache is only an accelerator: losing it costs prefill time, never output.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import mlx.core as mx
import numpy as np

from ..pagecache import release
from .sessions import cache_offset, recurrent_states

FORMAT = 1
MAGIC = b"APKVC001"
_PREFIX = len(MAGIC) + 32 + 8  # magic, sha256 of the rest, header length
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_LAYOUT_DIR = re.compile(r"^[0-9a-f]{32}$")
_READ_THREADS = 4
# numpy storage for each MLX dtype a cache holds (bfloat16 travels as its bits)
_STORAGE = {
    "bfloat16": np.uint16,
    "float16": np.float16,
    "float32": np.float32,
    "int8": np.int8,
    "int16": np.int16,
    "int32": np.int32,
    "int64": np.int64,
    "uint8": np.uint8,
    "uint16": np.uint16,
    "uint32": np.uint32,
    "bool": np.bool_,
}


class CacheError(Exception):
    """A file that is missing, damaged or does not fit this model's caches."""


@dataclass
class Checkpoint:
    key: str
    offset: int
    blocks: tuple[str, ...]
    logits: bool
    nbytes: int
    used: float


@dataclass
class Restored:
    cache: list
    offset: int
    logits: mx.array | None
    draft: object | None
    load_ms: int


@dataclass
class DiskStats:
    written_bytes: int = 0
    read_bytes: int = 0
    spills: int = 0
    restores: int = 0
    errors: int = 0
    deleted: int = 0


def layout_digest(layout: dict) -> str:
    return hashlib.sha256(json.dumps(layout, sort_keys=True).encode()).hexdigest()[:32]


def _is_recurrent(entry) -> bool:
    from mlx_vlm.models.cache import ArraysCache

    return isinstance(entry, ArraysCache)


def _kv_parts(entry) -> list[tuple[int, mx.array, int]]:
    """(index in the QSA state, array, token axis) for keys, values, indexer keys and
    indexer positions. The indexer's block summaries (slots 4, 5: means of every 4 indexer
    keys) are derived: mlx-vlm drops them on every trim and the next forward rebuilds them
    from the indexer keys, as after a snapshot restore. They are not written."""
    state = entry.state
    if len(state) != 6:
        raise CacheError("unsupported attention cache state")
    parts = []
    for index, axis in ((0, 2), (1, 2), (2, 1), (3, -1)):
        array = state[index]
        if array is not None:
            parts.append((index, array, axis % array.ndim))
    return parts


def _to_numpy(array: mx.array) -> tuple[str, np.ndarray]:
    name = str(array.dtype).rsplit(".", 1)[-1]
    if name not in _STORAGE:
        raise CacheError(f"unsupported dtype {name}")
    if array.size == 0:
        return name, np.empty(array.shape, dtype=_STORAGE[name])
    if name == "bfloat16":
        array = array.view(mx.uint16)
    return name, np.array(mx.contiguous(array))


def _to_mlx(name: str, values: np.ndarray) -> mx.array:
    array = mx.array(values)
    return array.view(mx.bfloat16) if name == "bfloat16" else array


def _allocate(name: str, shape: list[int]) -> tuple[mx.array, np.ndarray]:
    """A new MLX array (bfloat16 as its uint16 bits) and a writable host view of its
    memory. Unified memory: restored KV is read straight into the arrays the cache will
    hold. Staging it in host buffers first meant two copies of a 200K session's 6 GB at
    once, and the kernel compressed ~7 GB of other programs to make room (P4 validation)."""
    import ctypes

    storage = _STORAGE[name]
    dtype = {"bfloat16": mx.uint16, "bool": mx.bool_}.get(name) or getattr(mx, name)
    array = mx.zeros(shape, dtype=dtype)
    mx.eval(array)
    exported = np.asarray(memoryview(array))
    if not exported.flags.c_contiguous or exported.nbytes != array.nbytes:
        raise CacheError("an MLX array is not one contiguous buffer")
    raw = (ctypes.c_byte * max(array.nbytes, 1)).from_address(exported.ctypes.data)
    host = np.frombuffer(raw, dtype=storage, count=array.size).reshape(shape)
    return array, host


def _place(buffer: np.ndarray, axis: int, start: int, values: np.ndarray) -> None:
    index = [slice(None)] * buffer.ndim
    index[axis] = slice(start, start + values.shape[axis])
    buffer[tuple(index)] = values


class DiskCache:
    def __init__(
        self,
        root: Path,
        layout: dict,
        *,
        capacity_bytes: int,
        block_tokens: int,
    ):
        self.root = Path(root)
        self.layout = {**layout, "format": FORMAT, "block_tokens": block_tokens}
        self.digest = layout_digest(self.layout)
        self.dir = self.root / self.digest
        self.block_dir = self.dir / "blocks"
        self.checkpoint_dir = self.dir / "checkpoints"
        self.capacity = int(capacity_bytes)
        self.block_tokens = int(block_tokens)
        self.seed = hashlib.sha256(b"aporisa-kv\0" + self.digest.encode()).digest()
        self.blocks: dict[str, int] = {}  # hash -> file bytes
        self.checkpoints: dict[str, Checkpoint] = {}
        self.stats = DiskStats()
        self._open()

    # --- index ----------------------------------------------------------------------------

    def _open(self) -> None:
        for directory in (self.root, self.dir, self.block_dir, self.checkpoint_dir):
            directory.mkdir(mode=0o700, exist_ok=True)
            os.chmod(directory, 0o700)
        record = self.dir / "layout.json"
        if not record.is_file():
            self._write_small(record, json.dumps(self.layout, sort_keys=True, indent=2))
        self._remove_other_layouts()
        for path in self.block_dir.iterdir():
            if path.name.endswith(".tmp"):
                self._unlink(path)
            elif path.suffix == ".blk" and _HEX64.match(path.stem):
                self.blocks[path.stem] = path.stat().st_size
        for path in self.checkpoint_dir.iterdir():
            if path.name.endswith(".tmp"):
                self._unlink(path)
            elif path.suffix == ".ckpt" and _HEX64.match(path.stem):
                try:
                    header = self._header(path)
                    self.checkpoints[path.stem] = Checkpoint(
                        path.stem,
                        int(header["offset"]),
                        tuple(header["blocks"]),
                        bool(header["logits"]),
                        path.stat().st_size,
                        path.stat().st_mtime,
                    )
                except (OSError, ValueError, KeyError, TypeError, CacheError):
                    self._unlink(path)
        self._make_space(0, set())

    def _remove_other_layouts(self) -> None:
        """Caches of another model, format or MLX version are never read again."""
        for directory in self.root.iterdir():
            if directory == self.dir or not directory.is_dir():
                continue
            if not _LAYOUT_DIR.match(directory.name):
                continue
            for sub, suffixes in (("blocks", (".blk", ".tmp")), ("checkpoints", (".ckpt", ".tmp"))):
                path = directory / sub
                if path.is_dir():
                    for file in path.iterdir():
                        if file.suffix in suffixes or file.name.endswith(".tmp"):
                            self._unlink(file)
                    with _quiet():
                        path.rmdir()
            self._unlink(directory / "layout.json")
            with _quiet():
                directory.rmdir()

    def total_bytes(self) -> int:
        return sum(self.blocks.values()) + sum(c.nbytes for c in self.checkpoints.values())

    def status(self) -> dict:
        return {
            "ssd_cache_bytes": self.total_bytes(),
            "ssd_checkpoints": len(self.checkpoints),
            "ssd_written_bytes": self.stats.written_bytes,
            "ssd_read_bytes": self.stats.read_bytes,
            "ssd_errors": self.stats.errors,
        }

    def _make_space(self, need: int, keep_blocks: set[str]) -> None:
        """Deletes least recently used checkpoints until `need` more bytes fit, then every
        block no checkpoint (and no write in progress) references."""
        while self.checkpoints and self.total_bytes() + need > self.capacity:
            oldest = min(self.checkpoints.values(), key=lambda c: c.used)
            self._drop_checkpoint(oldest)
            self._collect(keep_blocks)
        self._collect(keep_blocks)

    def _collect(self, keep_blocks: set[str]) -> None:
        referenced = set(keep_blocks)
        for checkpoint in self.checkpoints.values():
            referenced.update(checkpoint.blocks)
        for name in [b for b in self.blocks if b not in referenced]:
            self._unlink(self._block_path(name))
            del self.blocks[name]
            self.stats.deleted += 1

    def _drop_checkpoint(self, checkpoint: Checkpoint) -> None:
        self._unlink(self._checkpoint_path(checkpoint.key))
        self.checkpoints.pop(checkpoint.key, None)
        self.stats.deleted += 1

    def _block_path(self, name: str) -> Path:
        return self.block_dir / f"{name}.blk"

    def _checkpoint_path(self, key: str) -> Path:
        return self.checkpoint_dir / f"{key}.ckpt"

    # --- hashing --------------------------------------------------------------------------

    def chain(self, tokens: np.ndarray, blocks: int) -> list[bytes]:
        """[H_0, H_1, .. H_blocks] over the full blocks of `tokens` (int32)."""
        size = self.block_tokens
        hashes = [self.seed]
        for index in range(blocks):
            block = tokens[index * size : (index + 1) * size]
            hashes.append(hashlib.sha256(hashes[-1] + block.astype("<i4").tobytes()).digest())
        return hashes

    @staticmethod
    def checkpoint_key(base: bytes, tail: np.ndarray) -> str:
        return hashlib.sha256(base + b"tail" + tail.astype("<i4").tobytes()).hexdigest()

    # --- spill ----------------------------------------------------------------------------

    def spill(self, session, drafter, deadline: float | None = None) -> int:
        """Writes what `session` adds to the cache; returns the bytes written. Never raises:
        a failed spill only loses the acceleration."""
        try:
            return self._spill(session, drafter, deadline)
        except Exception:
            self.stats.errors += 1
            traceback.print_exc(file=sys.stderr)
            return 0

    def _spill(self, session, drafter, deadline: float | None) -> int:
        size = self.block_tokens
        tokens = session.token_array()
        total = int(tokens.size)
        cache = session.cache
        if total < size or not cache or cache_offset(cache) != total:
            return 0
        draft = session.draft
        if drafter is not None:
            if draft is None:
                return 0
            drafter.flush(draft)
            if draft.appended or draft.hidden is None or draft.offset() != total - 1:
                return 0
            mx.eval(draft.arrays())
        points = [(total, recurrent_states(cache), session.logits, draft.hidden if draft else None)]
        for snap in reversed(session.snapshots):
            if size <= snap.offset < total and (drafter is None or snap.draft is not None):
                points.append((snap.offset, snap.states, snap.logits, snap.draft))
                break
        hashes = self.chain(tokens, total // size)
        wanted = []
        for offset, states, logits, hidden in points:
            blocks = offset // size
            key = self.checkpoint_key(hashes[blocks], tokens[blocks * size : offset])
            if key in self.checkpoints:
                self._touch(self.checkpoints[key])
            else:
                wanted.append((key, offset, states, logits, hidden))
        if not wanted:
            return 0
        names = [h.hex() for h in hashes[1 : max(p[1] for p in wanted) // size + 1]]
        fresh = [i for i, name in enumerate(names) if name not in self.blocks]
        per_token = sum(
            array.nbytes // max(array.shape[axis], 1)
            for _, array, axis in self._kv(cache, draft, 0, total)
        )
        tails = sum(offset % size for _, offset, _, _, _ in wanted)
        fixed = sum(
            value.nbytes
            for _, _, states, logits, hidden in wanted
            for value in [*(v for s in states.values() for v in s), logits, hidden]
            if value is not None
        )
        need = (len(fresh) * size + tails) * per_token + fixed
        if need > self.capacity:
            return 0
        self._make_space(need, set(names))
        before = self.stats.written_bytes
        for index in fresh:
            if deadline is not None and time.monotonic() > deadline:
                return self.stats.written_bytes - before
            arrays = self._kv(cache, draft, index * size, (index + 1) * size)
            nbytes = self._write(self._block_path(names[index]), {"kind": "block"}, arrays)
            self.blocks[names[index]] = nbytes
        for key, offset, states, logits, hidden in wanted:
            if deadline is not None and time.monotonic() > deadline:
                break
            blocks = offset // size
            arrays = self._kv(cache, draft, blocks * size, offset)
            for layer, values in states.items():
                for slot, value in enumerate(values):
                    if value is not None:
                        arrays.append((f"r{layer}.{slot}", value, None))
            if logits is not None:
                arrays.append(("logits", logits, None))
            if hidden is not None:
                arrays.append(("hidden", hidden, None))
            header = {
                "kind": "checkpoint",
                "offset": offset,
                "blocks": names[:blocks],
                "logits": logits is not None,
            }
            nbytes = self._write(self._checkpoint_path(key), header, arrays)
            self.checkpoints[key] = Checkpoint(
                key, offset, tuple(names[:blocks]), logits is not None, nbytes, time.time()
            )
        self.stats.spills += 1
        return self.stats.written_bytes - before

    @staticmethod
    def _kv(cache: list, draft, begin: int, end: int) -> list:
        """KV of target positions [begin, end) and the drafter entries pairing tokens
        begin..end-1 with their previous hidden state ([begin-1, end-1), from 0)."""
        arrays = []
        for layer, entry in enumerate(cache):
            if _is_recurrent(entry):
                continue
            for slot, array, axis in _kv_parts(entry):
                arrays.append((f"t{layer}.{slot}", _slice(array, axis, begin, end), axis))
        if draft is not None:
            for layer, entry in enumerate(draft.cache):
                for slot, array, axis in _kv_parts(entry):
                    piece = _slice(array, axis, max(begin - 1, 0), end - 1)
                    arrays.append((f"d{layer}.{slot}", piece, axis))
        return arrays

    def _touch(self, checkpoint: Checkpoint) -> None:
        checkpoint.used = time.time()
        with _quiet():
            os.utime(self._checkpoint_path(checkpoint.key))

    # --- restore --------------------------------------------------------------------------

    def restore(self, tokens: list[int], at_least: int, make_cache, drafter) -> Restored | None:
        """The deepest checkpoint on `tokens`' prefix with an offset >= `at_least` (usable at
        the very end only with its logits), loaded and checked; None when there is none."""
        if not self.checkpoints:
            return None
        size = self.block_tokens
        request = np.asarray(tokens, dtype=np.int32)
        hashes = self.chain(request, request.size // size)
        names = [h.hex() for h in hashes[1:]]
        found = []
        for checkpoint in self.checkpoints.values():
            blocks = len(checkpoint.blocks)
            offset = checkpoint.offset
            if offset < at_least or offset > request.size:
                continue
            if offset == request.size and not checkpoint.logits:
                continue
            if tuple(names[:blocks]) != checkpoint.blocks:
                continue
            tail = request[blocks * size : offset]
            if self.checkpoint_key(hashes[blocks], tail) == checkpoint.key:
                found.append(checkpoint)
        for checkpoint in sorted(found, key=lambda c: -c.offset):
            try:
                restored = self._load(checkpoint, make_cache, drafter)
            except (OSError, ValueError, KeyError, TypeError, CacheError):
                self.stats.errors += 1
                traceback.print_exc(file=sys.stderr)
                self._drop_checkpoint(checkpoint)
                continue
            self._touch(checkpoint)
            self.stats.restores += 1
            return restored
        return None

    def _load(self, checkpoint: Checkpoint, make_cache, drafter) -> Restored:
        started = time.monotonic()
        size = self.block_tokens
        offset, blocks = checkpoint.offset, len(checkpoint.blocks)
        base = blocks * size
        header, tensors = self._read(self._checkpoint_path(checkpoint.key))
        self.stats.read_bytes += checkpoint.nbytes
        if (
            header.get("kind") != "checkpoint"
            or header.get("offset") != offset
            or tuple(header.get("blocks") or ()) != checkpoint.blocks
        ):
            raise CacheError("checkpoint header does not match its index entry")
        layout = header["tensors"]
        target = make_cache()
        draft = drafter.new_state() if drafter is not None else None
        kv_names = {name for name in layout if name[0] in "td"}
        _check_kv(kv_names, target, draft)
        arrays: dict[str, mx.array] = {}
        buffers: dict[str, np.ndarray] = {}  # host views of `arrays`, written by the reads
        for name in sorted(kv_names):
            info = layout[name]
            axis = int(info["axis"])
            length = offset if name[0] == "t" else offset - 1
            shape = list(info["shape"])
            shape[axis] = length
            arrays[name], buffers[name] = _allocate(info["dtype"], shape)
            start = base if name[0] == "t" else base - 1
            _place(buffers[name], axis, start, tensors[name])

        def fill(index: int) -> int:
            path = self._block_path(checkpoint.blocks[index])
            block_header, block = self._read(path)
            if block_header.get("kind") != "block" or set(block) != kv_names:
                raise CacheError("block does not match the checkpoint")
            for name, values in block.items():
                buffer = buffers[name]
                axis = int(block_header["tensors"][name]["axis"])
                start = index * size if name[0] == "t" else max(index * size - 1, 0)
                length = size if name[0] == "t" or index else size - 1
                if values.dtype != buffer.dtype or values.shape[axis] != length:
                    raise CacheError("block tensor shape does not match")
                _place(buffer, axis, start, values)
            return path.stat().st_size

        with ThreadPoolExecutor(_READ_THREADS) as pool:
            self.stats.read_bytes += sum(pool.map(fill, range(blocks)))
        buffers.clear()  # every write is done; the arrays are MLX's alone from here
        for layer, entry in enumerate(target):
            if _is_recurrent(entry):
                names = {n for n in layout if n.startswith(f"r{layer}.")}
                slots = len(entry.cache)
                if any(int(n.split(".")[1]) >= slots for n in names):
                    raise CacheError("recurrent state does not match the model")
                entry.state = [
                    _to_mlx(layout[f"r{layer}.{s}"]["dtype"], tensors[f"r{layer}.{s}"])
                    if f"r{layer}.{s}" in names
                    else None
                    for s in range(slots)
                ]
            else:
                entry.state = _assemble(arrays, layout, f"t{layer}")
        if draft is not None:
            for layer, entry in enumerate(draft.cache):
                entry.state = _assemble(arrays, layout, f"d{layer}")
            if "hidden" not in tensors:
                raise CacheError("checkpoint has no drafter hidden state")
            draft.hidden = _to_mlx(layout["hidden"]["dtype"], tensors["hidden"])
        logits = None
        if "logits" in tensors:
            logits = _to_mlx(layout["logits"]["dtype"], tensors["logits"])
        mx.eval(
            [entry.state for entry in target],
            draft.arrays() if draft is not None else [],
            logits if logits is not None else [],
        )
        if cache_offset(target) != offset or (draft is not None and draft.offset() != offset - 1):
            raise CacheError("restored caches do not reach the checkpoint offset")
        return Restored(target, offset, logits, draft, round((time.monotonic() - started) * 1000))

    # --- files ----------------------------------------------------------------------------

    def _write(self, path: Path, header: dict, arrays: list) -> int:
        """One file: magic, sha256 of what follows, header length, JSON header, tensors.
        Written to a temporary name, synced, then renamed; its pages are then released."""
        entries, payload, offset = {}, [], 0
        for name, array, axis in arrays:
            dtype, values = _to_numpy(array)
            entries[name] = {
                "dtype": dtype,
                "shape": list(values.shape),
                "offset": offset,
                "nbytes": int(values.nbytes),
            }
            if axis is not None:
                entries[name]["axis"] = axis
            payload.append(values)
            offset += values.nbytes
        head = json.dumps({**header, "tensors": entries}).encode()
        digest = hashlib.sha256(head)
        temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(descriptor, "wb") as file:
                file.write(MAGIC + bytes(32) + len(head).to_bytes(8, "little") + head)
                for values in payload:
                    if values.nbytes == 0:  # e.g. the KV tail of a checkpoint on a block edge
                        continue
                    data = memoryview(np.ascontiguousarray(values)).cast("B")
                    digest.update(data)
                    file.write(data)
                file.seek(len(MAGIC))
                file.write(digest.digest())
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, path)
        except BaseException:
            self._unlink(temporary)
            raise
        with _quiet():
            release(path)
        self.stats.written_bytes += _PREFIX + len(head) + offset
        return _PREFIX + len(head) + offset

    def _read(self, path: Path) -> tuple[dict, dict[str, np.ndarray]]:
        data = path.read_bytes()
        with _quiet():
            release(path)
        if len(data) < _PREFIX or data[: len(MAGIC)] != MAGIC:
            raise CacheError("not a cache file")
        stored = data[len(MAGIC) : len(MAGIC) + 32]
        length = int.from_bytes(data[len(MAGIC) + 32 : _PREFIX], "little")
        body = memoryview(data)[_PREFIX:]
        if hashlib.sha256(body).digest() != stored:
            raise CacheError("checksum mismatch")
        header = json.loads(bytes(body[:length]))
        tensors = {}
        start = _PREFIX + length
        for name, info in header["tensors"].items():
            dtype = _STORAGE[info["dtype"]]
            count = int(np.prod(info["shape"], dtype=np.int64))
            if count * np.dtype(dtype).itemsize != info["nbytes"]:
                raise CacheError("tensor size does not match its shape")
            values = np.frombuffer(data, dtype=dtype, count=count, offset=start + info["offset"])
            tensors[name] = values.reshape(info["shape"])
        return header, tensors

    @staticmethod
    def _header(path: Path) -> dict:
        with open(path, "rb") as file:
            prefix = file.read(_PREFIX)
            if len(prefix) < _PREFIX or prefix[: len(MAGIC)] != MAGIC:
                raise CacheError("not a cache file")
            length = int.from_bytes(prefix[len(MAGIC) + 32 :], "little")
            return json.loads(file.read(length))

    @staticmethod
    def _write_small(path: Path, text: str) -> None:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "w") as file:
            file.write(text)

    @staticmethod
    def _unlink(path: Path) -> None:
        with _quiet():
            path.unlink()


def _slice(array: mx.array, axis: int, begin: int, end: int) -> mx.array:
    index = [slice(None)] * array.ndim
    index[axis] = slice(begin, end)
    return array[tuple(index)]


def _check_kv(names: set[str], target: list, draft) -> None:
    """The KV tensors of a checkpoint name exactly this model's attention layers (target
    `t<layer>`, drafter `d<layer>`), each with keys and values (slots 0, 1)."""
    layers = {f"t{i}" for i, entry in enumerate(target) if not _is_recurrent(entry)}
    if draft is not None:
        layers |= {f"d{i}" for i in range(len(draft.cache))}
    slots: dict[str, set[str]] = {}
    for name in names:
        layer, _, slot = name.partition(".")
        if layer not in layers or slot not in {"0", "1", "2", "3"}:
            raise CacheError("checkpoint attention layers do not match the model")
        slots.setdefault(layer, set()).add(slot)
    if set(slots) != layers or any(not {"0", "1"} <= held for held in slots.values()):
        raise CacheError("checkpoint attention layers do not match the model")


def _assemble(arrays: dict[str, mx.array], layout: dict, prefix: str) -> tuple:
    """A QSA cache state (keys, values, indexer keys, indexer positions) from the filled
    arrays; bfloat16 ones were filled as their uint16 bits."""
    parts = []
    for slot in range(4):
        name = f"{prefix}.{slot}"
        array = arrays.pop(name, None)
        if array is not None and layout[name]["dtype"] == "bfloat16":
            array = array.view(mx.bfloat16)
            mx.eval(array)
        parts.append(array)
    return tuple(parts)


class _quiet:
    """Suppresses OSError: cleanup and page-cache release are best effort."""

    def __enter__(self):
        return self

    def __exit__(self, kind, value, trace):
        return kind is not None and issubclass(kind, OSError)
