"""Local weight identities, records and directory leases (AGENTS.md, DEVELOPMENT_PLAN 14.6).

Ported from local_llm (assets.py, asset_lock.py) without the platform level. A record
`.runtime/model-assets/<folder>.json` is the only statement of what a weight directory is:

  {"schema": 1, "identity": ..., "directory": <folder>, "version": <subdirectory>,
   "state": downloading|converting|ready|failed|interrupted,
   "source": {"kind": "download", "repository", "revision"}
           | {"kind": "convert", "recipe", "recipe_digest", "spec", "tools", "from": {...}},
   "files": {relative path: {"size", "sha256"}}}

Weights live in `.runtime/models/<folder>/<version>/`: the revision for downloads, the recipe
digest for conversions. Directory leases are advisory flocks: the service holds a shared
lease while it uses a directory; download, convert and delete need the exclusive one.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

SCHEMA = 1
STATES = {"downloading", "converting", "ready", "failed", "interrupted"}
FOLDER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
REPOSITORY = re.compile(r"[A-Za-z0-9][\w.-]*/[A-Za-z0-9][\w.-]*")
REVISION = re.compile(r"[a-f0-9]{40}")
VERSION = re.compile(r"[a-f0-9]{16,40}")
DIGEST = re.compile(r"[a-f0-9]{64}")
# Small files are hashed on every start; large tensors only by prepare (decision 3).
QUICK_HASH_SUFFIXES = (".safetensors",)


@dataclass(frozen=True)
class Layout:
    root: Path

    @property
    def runtime(self) -> Path:
        return self.root / ".runtime"

    @property
    def models(self) -> Path:
        return self.runtime / "models"

    @property
    def records(self) -> Path:
        return self.runtime / "model-assets"

    @property
    def locks(self) -> Path:
        return self.runtime / "model-locks"

    @property
    def staging(self) -> Path:
        return self.runtime / "weight-staging"

    def record(self, folder: str) -> Path:
        return self.records / f"{safe_folder(folder)}.json"

    def weights(self, record: dict) -> Path:
        return self.models / record["directory"] / record["version"]


def safe_folder(name: str) -> str:
    if not isinstance(name, str) or not FOLDER.fullmatch(name):
        raise ValueError("Use a model folder basename, not a path")
    return name


def validate_identity(identity) -> str:
    if (
        not isinstance(identity, str)
        or not identity
        or identity != identity.strip()
        or len(identity) > 128
        or any(not c.isprintable() for c in identity)
    ):
        raise ValueError("A nonempty explicit readable identity is required")
    return identity


def folder_for_repository(repository: str) -> str:
    folder = repository.replace("/", "--")
    if len(folder) > 128:
        folder = folder[:110] + "-" + hashlib.sha256(repository.encode()).hexdigest()[:16]
    return safe_folder(folder)


def folder_for_identity(identity: str) -> str:
    """Folder of a converted artifact: the identity with unsafe characters replaced."""
    folder = re.sub(r"[^A-Za-z0-9._-]", "-", validate_identity(identity)).lstrip("._-")
    return safe_folder(folder[:128] or "model")


def _no_links(*paths: Path) -> None:
    for path in paths:
        if path.is_symlink():
            raise ValueError("Weight and metadata paths must not be linked")


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    _no_links(path.parent, path, temporary)
    temporary.write_text(json.dumps(value, sort_keys=True, indent=1) + "\n", encoding="utf-8")
    temporary.replace(path)


def _validate_source(source) -> None:
    if not isinstance(source, dict):
        raise ValueError("Invalid asset source")
    if source.get("kind") == "download":
        if not REPOSITORY.fullmatch(source.get("repository", "")) or not REVISION.fullmatch(
            source.get("revision", "")
        ):
            raise ValueError("Invalid download source")
    elif source.get("kind") == "convert":
        origin = source.get("from")
        if (
            not isinstance(source.get("recipe"), str)
            or not DIGEST.fullmatch(source.get("recipe_digest", ""))
            or not isinstance(source.get("spec"), dict)
            or not isinstance(source.get("tools"), dict)
            or not isinstance(origin, dict)
        ):
            raise ValueError("Invalid conversion source")
        validate_identity(origin.get("identity"))
        if not REPOSITORY.fullmatch(origin.get("repository", "")) or not REVISION.fullmatch(
            origin.get("revision", "")
        ):
            raise ValueError("Conversion source must name its upstream repository and revision")
    else:
        raise ValueError("Unknown asset source kind")


def validate_record(data, folder: str) -> dict:
    safe_folder(folder)
    if not isinstance(data, dict) or data.get("schema") != SCHEMA:
        raise ValueError("Invalid asset record schema")
    validate_identity(data.get("identity"))
    if (
        data.get("directory") != folder
        or data.get("state") not in STATES
        or not VERSION.fullmatch(data.get("version", ""))
        or not isinstance(data.get("files"), dict)
    ):
        raise ValueError("Invalid asset record")
    _validate_source(data.get("source"))
    source = data["source"]
    expected = source["revision"] if source["kind"] == "download" else source["recipe_digest"][:16]
    if data["version"] != expected:
        raise ValueError("Asset version does not match its source")
    for name, metadata in data["files"].items():
        path = PurePosixPath(name)
        if (
            not path.parts
            or path.is_absolute()
            or ".." in path.parts
            or ".cache" in path.parts
            or str(path) != name
            or not isinstance(metadata, dict)
            or type(metadata.get("size")) is not int
            or metadata["size"] < 0
            or not DIGEST.fullmatch(metadata.get("sha256", ""))
        ):
            raise ValueError("Invalid asset inventory")
    if data["state"] == "ready" and not data["files"]:
        raise ValueError("Empty ready inventory")
    return data


def read_record(path: Path) -> dict:
    _no_links(path.parent, path)
    if path.stat().st_size > 4 * 1024**2:
        raise ValueError("Asset record is too large")
    return validate_record(json.loads(path.read_text()), path.stem)


def records(layout: Layout, *, strict: bool = True) -> list[dict]:
    """All records; with strict=False unreadable records are skipped (service selection)."""
    _no_links(layout.records)
    found = []
    for path in sorted(layout.records.glob("*.json")) if layout.records.is_dir() else []:
        try:
            found.append(read_record(path))
        except (ValueError, OSError, TypeError, json.JSONDecodeError):
            if strict:
                raise
    return found


def resolve_identity(layout: Layout, identity: str) -> dict:
    """The unique ready record of `identity`; unrelated broken records do not participate."""
    matches = [r for r in records(layout, strict=False) if r["identity"] == identity]
    if len(matches) != 1 or matches[0]["state"] != "ready":
        raise ValueError("Selected identity has no unique completed local weights")
    return matches[0]


@contextmanager
def namespace_lock(layout: Layout):
    """Short lock around identity bookkeeping; never held during network I/O or hashing."""
    _no_links(layout.locks)
    layout.locks.mkdir(parents=True, exist_ok=True)
    fd = os.open(layout.locks / ".identities.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


@contextmanager
def asset_lock(layout: Layout, folder: str, *, exclusive: bool = False):
    safe_folder(folder)
    _no_links(layout.locks)
    layout.locks.mkdir(parents=True, exist_ok=True)
    # Never unlink lock files: replacing the inode would break cross-process exclusion.
    fd = os.open(layout.locks / f"{folder}.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Model asset is in use; no files were changed") from None
        yield fd
    finally:
        os.close(fd)


def lease_active(layout: Layout, folder: str) -> bool | None:
    """Read-only: is an exclusive lease held? Never creates a lock file."""
    try:
        fd = os.open(layout.locks / f"{safe_folder(folder)}.lock", os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return False
    except OSError:
        return None
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        except OSError:
            return None
        return False
    finally:
        os.close(fd)


def sha256(path: Path) -> str:
    """SHA256 of a weight file; its pages are released from the page cache afterwards, so
    verifying ~100 GiB does not push other programs' memory into compression and swap."""
    from ..pagecache import release_all

    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024**2), b""):
            digest.update(block)
    release_all([path])
    return digest.hexdigest()


def listed_files(directory: Path) -> set[str]:
    _no_links(directory.parent, directory)
    if not directory.is_dir():
        raise ValueError("Weight directory is missing")
    files = list(directory.rglob("*"))
    if any(p.is_symlink() for p in files):
        raise ValueError("Linked weight files are not supported")
    return {
        str(p.relative_to(directory))
        for p in files
        if p.is_file() and ".cache" not in p.relative_to(directory).parts
    }


def inventory(directory: Path, *, workers: int = 8) -> dict[str, dict]:
    names = sorted(listed_files(directory))
    with ThreadPoolExecutor(workers) as pool:
        digests = list(pool.map(lambda name: sha256(directory / name), names))
    return {
        name: {"size": (directory / name).stat().st_size, "sha256": digest}
        for name, digest in zip(names, digests, strict=True)
    }


def verify_inventory(
    directory: Path, files: dict[str, dict], *, full: bool, workers: int = 8
) -> None:
    """Exact file set and sizes; SHA256 of every file (full) or of the small ones (quick)."""
    if not files or listed_files(directory) != set(files):
        raise ValueError("Weight inventory mismatch")
    for name, metadata in files.items():
        if (directory / name).stat().st_size != metadata["size"]:
            raise ValueError("Weight size mismatch")
    names = [n for n in files if full or not n.endswith(QUICK_HASH_SUFFIXES)]
    with ThreadPoolExecutor(workers) as pool:
        digests = list(pool.map(lambda name: sha256(directory / name), names))
    if any(digest != files[name]["sha256"] for name, digest in zip(names, digests, strict=True)):
        raise ValueError("Weight checksum mismatch")
