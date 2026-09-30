"""Receipts written by prepare and checked by doctor and run (14.6, decision 3).

- Source receipt: a digest of the backend sources, scripts, service template and lock.
  Changing any of them requires prepare again (AGENTS: "修改依赖后需要重新执行 prepare").
- Assets receipt: prepare verified the full SHA256 inventory of the selected identity's
  record (and of its profile's draft identity, B2-2). start/run then check only that the
  receipt still matches the records, the exact file sets, every size, and the hashes of the
  small files.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from pathlib import Path

from ..configs.models import PROFILES, ModelProfile, active_pointer
from .assets import Layout, asset_lock, resolve_identity, verify_inventory

SOURCE_DIRS = ("backend/src", "scripts", "deploy/templates")
SOURCE_FILES = (
    "backend/pyproject.toml",
    "backend/uv.lock",
    "backend_service.sh",
    "model_weights.sh",
)


def source_digest(root: Path) -> str:
    paths: list[Path] = []
    for directory in SOURCE_DIRS:
        base = root / directory
        if base.is_dir():
            paths.extend(
                p
                for p in base.rglob("*")
                if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc"
            )
    paths.extend(root / name for name in SOURCE_FILES if (root / name).is_file())
    digest = hashlib.sha256()
    for path in sorted(paths):
        digest.update(str(path.relative_to(root)).encode() + b"\0")
        digest.update(path.read_bytes())
    return digest.hexdigest()


def _receipt(root: Path, name: str) -> Path:
    return root / ".runtime" / name


def _write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, sort_keys=True))
    temporary.replace(path)


def write_source_receipt(root: Path) -> None:
    _write(_receipt(root, "prepared-source.json"), {"source_digest": source_digest(root)})


def verify_source_receipt(root: Path) -> None:
    try:
        data = json.loads(_receipt(root, "prepared-source.json").read_text())
    except (OSError, ValueError):
        raise ValueError("Source preparation is missing") from None
    if data != {"source_digest": source_digest(root)}:
        raise ValueError("Source preparation is stale")


@dataclass(frozen=True)
class Component:
    identity: str
    record: dict
    directory: Path


@dataclass(frozen=True)
class Selection:
    alias: str
    identity: str
    profile: ModelProfile
    record: dict
    directory: Path
    draft: Component | None = None  # the profile's MTP draft model (B2-2)

    def components(self) -> list[Component]:
        served = Component(self.identity, self.record, self.directory)
        return [served] + ([self.draft] if self.draft is not None else [])


def select(layout: Layout, pointers: dict | None = None) -> Selection:
    """The pointed identity, its profile's draft identity and their unique ready records
    (no hashing). A missing draft record fails like a missing served one."""
    alias, identity = active_pointer(pointers)
    profile = PROFILES[identity]
    record = resolve_identity(layout, identity)
    draft = None
    if profile.draft_identity is not None:
        draft_record = resolve_identity(layout, profile.draft_identity)
        draft = Component(profile.draft_identity, draft_record, layout.weights(draft_record))
    return Selection(alias, identity, profile, record, layout.weights(record), draft)


@contextmanager
def leases(layout: Layout, selection: Selection) -> Iterator[None]:
    """Shared leases on every directory the service reads (served model and draft)."""
    with ExitStack() as stack:
        for component in selection.components():
            stack.enter_context(asset_lock(layout, component.record["directory"]))
        yield


def _record_digest(record: dict) -> str:
    return hashlib.sha256(json.dumps(record, sort_keys=True).encode()).hexdigest()


def _receipt_body(selection: Selection) -> dict:
    def entry(component: Component) -> dict:
        return {
            "identity": component.identity,
            "directory": component.record["directory"],
            "version": component.record["version"],
            "record_sha256": _record_digest(component.record),
        }

    served, *rest = selection.components()
    return {**entry(served), **({"draft": entry(rest[0])} if rest else {})}


def write_assets_receipt(layout: Layout, selection: Selection) -> None:
    _write(_receipt(layout.root, "prepared-assets.json"), _receipt_body(selection))


def verify_assets(layout: Layout, selection: Selection, *, full: bool) -> None:
    """full: every SHA256 (prepare). quick: receipt + file set + sizes + small-file hashes."""
    if not full:
        try:
            receipt = json.loads(_receipt(layout.root, "prepared-assets.json").read_text())
        except (OSError, ValueError):
            raise ValueError("Model assets were not verified by prepare") from None
        if receipt != _receipt_body(selection):
            raise ValueError("Model assets changed since prepare")
    for component in selection.components():
        verify_inventory(component.directory, component.record["files"], full=full)
