"""Standalone weight maintenance behind model_weights.sh: download | convert | list | delete.

Follows local_llm's weights.py (D-15): never touches configs, the service or admission.
download pins an immutable revision, stages, verifies every file, then publishes; convert
derives a new identity from a registered source with a packaged recipe; list is read-only
(no network, no hashing, no lock files); delete takes an exact folder name.
"""

from __future__ import annotations

import argparse
import errno
import hashlib
import importlib.util
import os
import shutil
import time
from contextlib import ExitStack, contextmanager
from pathlib import Path, PurePosixPath

from ..console import emit
from . import recipes
from .assets import (
    REPOSITORY,
    REVISION,
    SCHEMA,
    Layout,
    asset_lock,
    atomic_json,
    folder_for_identity,
    folder_for_repository,
    inventory,
    lease_active,
    namespace_lock,
    read_record,
    records,
    resolve_identity,
    safe_folder,
    sha256,
    validate_identity,
    verify_inventory,
)


def configure_transport(staging: Path) -> None:
    """Set before importing the Hub client; transport scratch stays inside the staging area."""
    cache = staging / "transport-cache"
    os.environ.update(
        HF_HUB_DISABLE_IMPLICIT_TOKEN="1",
        HF_HUB_DISABLE_TELEMETRY="1",
        HF_HUB_DISABLE_XET="0",
        HF_HOME=str(cache),
        HF_HUB_CACHE=str(cache / "hub"),
        HF_XET_CACHE=str(cache / "xet"),
        HF_XET_CHUNK_CACHE_SIZE_BYTES="0",
        HF_XET_LOG_DEST="/dev/null",
        RUST_LOG="off",
    )
    if importlib.util.find_spec("hf_xet") is None:
        raise ValueError("Xet transport is unavailable")


def failure_reason(error: BaseException | None) -> str:
    """Classified locally; never exposes upstream messages or signed URLs."""
    seen = set()
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        message = str(error).lower()
        if "xet transport is unavailable" in message:
            return "xet_unavailable: run ./backend_service.sh prepare"
        if getattr(error, "errno", None) == errno.ENOSPC:
            return "disk_full: free space on the project volume"
        if getattr(error, "errno", None) in {errno.EACCES, errno.EPERM, errno.EROFS}:
            return "storage_permission: check project ownership and write access"
        if "timeout" in type(error).__name__.lower() or "timed out" in message:
            return "network_timeout: retry the same command to resume"
        status = getattr(getattr(error, "response", None), "status_code", None)
        if status in {401, 403, 404}:
            return "repository_access: check repository availability and access"
        if status == 429:
            return "rate_limited: wait before resuming"
        if any(w in message for w in ("checksum", "size mismatch", "inventory mismatch")):
            return "integrity_error: files failed verification"
        if "asset is in use" in message:
            return "asset_in_use: the folder is locked by the service or another operation"
        if type(error) is ValueError and str(error):  # this package's fixed messages only
            return f"rejected: {error}"
        error = error.__cause__ or error.__context__
    return "operation_failed: check the arguments, connectivity and project storage"


@contextmanager
def track(record_path: Path):
    """Under the exclusive lease: a failure marks the record, staging is kept for resume."""
    try:
        yield
    except BaseException as error:
        try:
            record = read_record(record_path)
            if record["state"] != "ready":
                record["state"] = (
                    "interrupted" if isinstance(error, KeyboardInterrupt | SystemExit) else "failed"
                )
                atomic_json(record_path, record)
        except FileNotFoundError:
            pass
        except (ValueError, OSError):
            emit("WAIT", "Could not persist the failure state; staging retained. Use list.")
        raise


def _checked_dirs(*paths: Path) -> None:
    for path in paths:
        if path.is_symlink():
            raise ValueError("Weight directories must not be linked")


def verify_hub_file(path: Path, item) -> dict:
    name = item.rfilename
    parts = PurePosixPath(name).parts
    if not parts or PurePosixPath(name).is_absolute() or ".." in parts or ".cache" in parts:
        raise ValueError("Unsafe repository filename")
    file = path / name
    if not file.is_file() or file.resolve() != path.resolve().joinpath(*parts):
        raise ValueError("Incomplete or linked download")
    if item.size is None or file.stat().st_size != item.size:
        raise ValueError("Downloaded file size mismatch")
    digest = sha256(file)
    if item.lfs is not None:
        if digest != item.lfs.sha256:
            raise ValueError("Downloaded LFS checksum mismatch")
    else:
        git_hash = hashlib.sha1(f"blob {item.size}\0".encode())
        with file.open("rb") as stream:
            for block in iter(lambda: stream.read(1024**2), b""):
                git_hash.update(block)
        if git_hash.hexdigest() != item.blob_id:
            raise ValueError("Downloaded Git blob checksum mismatch")
    return {"size": item.size, "sha256": digest}


def verify_hub_files(path: Path, siblings, repair=None) -> dict:
    files = {}
    for item in siblings:
        try:
            files[item.rfilename] = verify_hub_file(path, item)
        except ValueError:
            if repair is None:
                raise
            repair(item.rfilename)  # exactly one re-download per damaged file
            files[item.rfilename] = verify_hub_file(path, item)
    actual = {
        str(p.relative_to(path))
        for p in path.rglob("*")
        if p.is_file() and ".cache" not in p.relative_to(path).parts
    }
    if actual != set(files) or not files:
        raise ValueError("Downloaded inventory mismatch")
    return files


def download(layout: Layout, repository: str, *, identity: str, revision: str | None = None):
    validate_identity(identity)
    if not REPOSITORY.fullmatch(repository):
        raise ValueError("Download requires an exact repository ID")
    if revision is not None and not REVISION.fullmatch(revision):
        raise ValueError("Revision must be an immutable 40-character commit")
    with ExitStack() as leases:
        with namespace_lock(layout):
            matching = [r for r in records(layout) if r["identity"] == identity]
            if len(matching) > 1:
                raise ValueError("Ambiguous local identity")
            record = matching[0] if matching else None
            if record and (
                record["source"].get("kind") != "download"
                or record["source"]["repository"] != repository
                or (revision is not None and revision != record["source"]["revision"])
            ):
                raise ValueError("Identity already belongs to another source")
            folder = record["directory"] if record else folder_for_repository(repository)
            record_path = layout.record(folder)
            if record_path.exists() and (not record or read_record(record_path) != record):
                raise ValueError("Folder already belongs to another identity")
            leases.enter_context(asset_lock(layout, folder, exclusive=True))
        destination = layout.models / folder
        staging = layout.staging / folder
        _checked_dirs(layout.models, destination, staging)
        if record:
            revision = record["source"]["revision"]
            try:
                verify_inventory(destination / revision, record["files"], full=True)
            except (ValueError, OSError):
                pass
            else:
                record["state"] = "ready"
                atomic_json(record_path, record)
                if staging.exists():
                    shutil.rmtree(staging)
                emit("READY", f"Existing weights verified: {folder}; no download required.")
                return
        elif destination.exists() and revision is None:
            raise ValueError("Unmanaged folder exists; pass --revision to verify and adopt it")
        with track(record_path):
            configure_transport(staging)
            from huggingface_hub import HfApi, hf_hub_download, snapshot_download

            api = HfApi(token=False)
            info = api.model_info(repository, revision=revision, files_metadata=True)
            if revision is not None and info.sha != revision:
                raise ValueError("Repository revision mismatch")
            revision = info.sha
            if not REVISION.fullmatch(revision or ""):
                raise ValueError("Repository did not resolve to an immutable revision")
            pending = {
                "schema": SCHEMA,
                "identity": identity,
                "directory": folder,
                "version": revision,
                "state": "downloading",
                "source": {"kind": "download", "repository": repository, "revision": revision},
                "files": {},
            }
            with namespace_lock(layout):
                if any(
                    r["identity"] == identity and r["directory"] != folder for r in records(layout)
                ):
                    raise ValueError("Identity was claimed by another operation")
                atomic_json(record_path, pending)
            published = destination / revision
            if not record and published.is_dir():
                # A complete directory from before records existed: verify, then adopt.
                emit("WAIT", "Verifying the existing directory against the repository...")
                pending["files"] = verify_hub_files(published, info.siblings)
                pending["state"] = "ready"
                atomic_json(record_path, pending)
                emit("READY", f"Existing weights verified and registered: {folder}.")
                return
            staging.mkdir(parents=True, exist_ok=True)
            target = staging / revision
            emit("INFO", f"Downloading {repository} at {revision}; folder={folder}")
            snapshot_download(
                repo_id=repository, revision=revision, local_dir=target, token=False, max_workers=2
            )
            emit("WAIT", "Transfer finished; verifying every file before publication.")
            pending["files"] = verify_hub_files(
                target,
                info.siblings,
                repair=lambda name: hf_hub_download(
                    repo_id=repository,
                    revision=revision,
                    local_dir=target,
                    filename=name,
                    token=False,
                    force_download=True,
                ),
            )
            _publish(layout, record_path, pending, target, staging)
            emit("READY", f"Weights verified: {folder}. Service and pointers unchanged.")


def _publish(
    layout: Layout, record_path: Path, record: dict, built: Path, staging: Path, *, cleanup=True
):
    """Verified inventory first (offline recovery), then rename, then the ready state."""
    atomic_json(record_path, record)
    destination = layout.models / record["directory"]
    destination.mkdir(parents=True, exist_ok=True)
    published = destination / record["version"]
    backup = staging / "previous"
    if backup.exists():
        shutil.rmtree(backup)
    if published.exists():
        published.rename(backup)
    built.rename(published)
    record["state"] = "ready"
    atomic_json(record_path, record)
    if cleanup and staging.exists():
        shutil.rmtree(staging)


def _claim(layout: Layout, identity: str, folder: str, version: str, source: dict) -> dict | None:
    """Reserves `identity` for `folder` (namespace lock held by the caller).

    Returns the existing ready record when it is already this exact output.
    """
    matching = [r for r in records(layout) if r["identity"] == identity]
    if matching and (matching[0]["directory"] != folder or matching[0]["source"] != source):
        raise ValueError("Identity already belongs to another source")
    record_path = layout.record(folder)
    if record_path.exists() and read_record(record_path)["identity"] != identity:
        raise ValueError("Folder already belongs to another identity")
    if matching and matching[0]["state"] == "ready":
        return matching[0]
    atomic_json(
        record_path,
        {
            "schema": SCHEMA,
            "identity": identity,
            "directory": folder,
            "version": version,
            "state": "converting",
            "source": source,
            "files": {},
        },
    )
    return None


def convert(
    layout: Layout,
    source_identity: str,
    *,
    recipe: str,
    identity: str,
    mtp_identity: str | None = None,
) -> None:
    if recipe not in recipes.RECIPES:
        raise ValueError("Unknown recipe")
    validate_identity(identity)
    outputs = [("model", identity)] + ([("mtp", mtp_identity)] if mtp_identity else [])
    if mtp_identity is not None and validate_identity(mtp_identity) == identity:
        raise ValueError("The MTP output needs its own identity")
    origin = resolve_identity(layout, source_identity)
    if origin["source"]["kind"] != "download":
        raise ValueError("Conversion needs a downloaded upstream checkpoint as its source")
    tools = recipes.tool_versions()
    digest = recipes.recipe_digest(recipe, tools)
    version = digest[:16]
    base = {
        "kind": "convert",
        "recipe": recipe,
        "recipe_digest": digest,
        "spec": recipes.RECIPES[recipe],
        "tools": tools,
        "from": {
            "identity": origin["identity"],
            "directory": origin["directory"],
            "version": origin["version"],
            "repository": origin["source"]["repository"],
            "revision": origin["source"]["revision"],
        },
    }
    with ExitStack() as leases:
        pending = []
        with namespace_lock(layout):
            for part, name in outputs:
                folder = folder_for_identity(name)
                existing = _claim(layout, name, folder, version, {**base, "output": part})
                pending.append((part, name, folder, existing))
            leases.enter_context(asset_lock(layout, origin["directory"]))
            for _, _, folder, _ in pending:
                leases.enter_context(asset_lock(layout, folder, exclusive=True))
        if all(existing for *_, existing in pending):
            emit("READY", "These outputs are already converted and registered; nothing to do.")
            return
        source_dir = layout.weights(origin)
        verify_inventory(source_dir, origin["files"], full=False)
        folder = pending[0][2]
        staging = layout.staging / folder
        work = staging / "work"
        _checked_dirs(layout.staging, staging)
        if work.exists():
            shutil.rmtree(work)  # a conversion cannot resume; start over
        work.mkdir(parents=True)
        source_bytes = sum(item["size"] for item in origin["files"].values())
        if shutil.disk_usage(work).free < source_bytes * 0.6:
            raise ValueError("Not enough free disk space for the conversion output")
        paths = {part: layout.record(f) for part, _, f, _ in pending}
        with ExitStack() as tracking:
            for path in paths.values():
                tracking.enter_context(track(path))
            served, drafter = recipes.convert(
                source_dir, recipe, work, mtp=mtp_identity is not None, emit=emit
            )
            built = {"model": served, "mtp": drafter}
            for part, name, folder_name, existing in pending:
                if existing:
                    continue
                directory = built[part]
                if directory is None:
                    raise ValueError("The conversion produced no MTP draft model")
                provenance = {
                    **base,
                    "output": part,
                    "identity": name,
                    "converted_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                }
                atomic_json(directory / "recipe.json", provenance)
                record = read_record(paths[part])
                record["files"] = inventory(directory)
                _publish(
                    layout,
                    paths[part],
                    record,
                    directory,
                    staging / f"previous-{part}",
                    cleanup=False,
                )
                emit("READY", f"Converted and registered {name}: {folder_name}/{version}.")
        if staging.exists():
            shutil.rmtree(staging)


def delete(layout: Layout, folder: str) -> None:
    safe_folder(folder)
    with asset_lock(layout, folder, exclusive=True):
        path, staging = layout.models / folder, layout.staging / folder
        record = layout.record(folder)
        _checked_dirs(path, staging, record)
        if not path.is_dir() and not staging.is_dir() and not record.exists():
            raise ValueError("Model folder is absent")
        for target in (path, staging):
            if target.exists():
                shutil.rmtree(target)
        with namespace_lock(layout):
            record.unlink(missing_ok=True)
    emit("READY", f"Deleted model folder and identity record: {folder}. Configuration unchanged.")


def list_weights(layout: Layout) -> list[tuple[str, str, str]]:
    """Directories and records only: no locks created, no hashing, no network."""
    folders: set[str] = set()
    for directory in (layout.models, layout.staging, layout.records):
        _checked_dirs(directory)
        if directory.exists():
            folders.update(
                p.stem if directory == layout.records else p.name
                for p in directory.iterdir()
                if (p.suffix == ".json" if directory == layout.records else p.is_dir())
            )
    rows = []
    for folder in sorted(folders):
        identity, state = "(unknown)", "unmanaged"
        try:
            data = read_record(layout.record(folder))
            identity, state = data["identity"], data["state"]
            if state in ("downloading", "converting"):
                active = lease_active(layout, folder)
                state = f"{state}" if active else "incomplete (not running)"
                if active is None:
                    state = "incomplete (activity unknown)"
            elif state == "ready":
                state = "present (not verified)" if layout.weights(data).is_dir() else "missing"
        except (ValueError, OSError, TypeError):
            if (layout.staging / folder).exists():
                state = "incomplete / unregistered"
        rows.append((folder, identity, state))
    return rows


def main() -> None:
    from ..configs.deployment import ROOT

    parser = argparse.ArgumentParser(prog="model_weights.sh", description=__doc__.splitlines()[0])
    modes = parser.add_subparsers(dest="mode", required=True)
    get = modes.add_parser("download", help="download and verify an exact repository revision")
    get.add_argument("repository", help="exact repository ID, e.g. owner/model")
    get.add_argument("--identity", required=True, help="explicit readable model identity")
    get.add_argument("--revision", help="immutable 40-character commit")
    make = modes.add_parser("convert", help="derive a new identity with a packaged recipe")
    make.add_argument("source", help="identity of a registered upstream checkpoint")
    make.add_argument("--recipe", required=True, choices=sorted(recipes.RECIPES))
    make.add_argument("--identity", required=True, help="identity of the served output")
    make.add_argument("--mtp-identity", help="also extract the MTP draft model as this identity")
    remove = modes.add_parser("delete", help="delete a folder, its staging and its record")
    remove.add_argument("folder", help="exact folder basename")
    modes.add_parser("list", help="read-only listing; no network, no hashing")
    args = parser.parse_args()
    layout = Layout(ROOT)
    os.umask(0o077)
    try:
        if args.mode == "download":
            download(layout, args.repository, identity=args.identity, revision=args.revision)
        elif args.mode == "convert":
            convert(
                layout,
                args.source,
                recipe=args.recipe,
                identity=args.identity,
                mtp_identity=args.mtp_identity,
            )
        elif args.mode == "delete":
            delete(layout, args.folder)
        else:
            rows = list_weights(layout)
            emit("INFO", "Folder -> identity [state]")
            for folder, identity, state in rows:
                emit("INFO", f"{folder} -> {identity} [{state}]")
            if not rows:
                emit("INFO", "No local weights or pending operations.")
    except KeyboardInterrupt:
        emit("WAIT", "Interrupted; staging retained for resume.")
        raise SystemExit(130) from None
    except Exception as error:  # noqa: BLE001 - classified, upstream text withheld
        emit("ERROR", f"{failure_reason(error)}. Service and pointers unchanged.")
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
