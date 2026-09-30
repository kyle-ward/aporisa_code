"""B0-2: verify a downloaded checkpoint against the Hugging Face tree at a pinned revision.

One-off exploration script (DEVELOPMENT_PLAN.md B0). Reads the remote tree metadata
(network, read-only), then hashes every local file: LFS files against their SHA256, small
files against their git blob id. Writes a manifest that B1-2 can adopt as the identity
record without hashing 185 GB again.

    backend/.venv/bin/python backend/scripts/b0_verify_checkpoint.py \
        --repo Qwen/Qwen3.8-Flash-Next-FP8 --revision <40-hex> --path <local dir>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

BLOCK = 8 * 1024 * 1024


def emit(tag: str, message: str) -> None:
    prefix = "ERROR:" if tag == "ERROR" else f"[{tag}]"
    print(f"[Aporisa Code] {prefix} {message}", flush=True)


def remote_tree(repo: str, revision: str) -> dict[str, dict]:
    from huggingface_hub import HfApi

    entries = {}
    for entry in HfApi().list_repo_tree(repo, revision=revision, recursive=True, expand=True):
        if not hasattr(entry, "size"):
            continue  # directories
        lfs = getattr(entry, "lfs", None)
        entries[entry.path] = {
            "size": entry.size,
            "sha256": lfs.sha256 if lfs else None,
            "blob_id": entry.blob_id,
        }
    return entries


def local_files(root: Path) -> set[str]:
    found = set()
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        if relative.parts[0] == ".cache" or not path.is_file():
            continue
        if path.is_symlink():
            raise ValueError(f"symlink in checkpoint: {relative}")
        found.add(str(relative))
    return found


def digest(path: Path, size: int) -> tuple[str, str]:
    sha256 = hashlib.sha256()
    blob = hashlib.sha1(f"blob {size}\0".encode())
    with path.open("rb") as stream:
        while block := stream.read(BLOCK):
            sha256.update(block)
            blob.update(block)
    return sha256.hexdigest(), blob.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--path", required=True, type=Path)
    parser.add_argument("--manifest", type=Path, help="default: <path>/../<revision>.manifest.json")
    parser.add_argument("--workers", type=int, default=min(8, os.cpu_count() or 4))
    args = parser.parse_args()
    if len(args.revision) != 40:
        emit("ERROR", "--revision must be a full 40-hex commit id.")
        return 2
    root = args.path.resolve()
    emit("WAIT", f"Reading the remote tree of {args.repo}@{args.revision[:7]}...")
    remote = remote_tree(args.repo, args.revision)
    local = local_files(root)
    missing, extra = sorted(set(remote) - local), sorted(local - set(remote))
    for name in missing:
        emit("MANUAL", f"missing locally: {name}")
    for name in extra:
        emit("MANUAL", f"not in the remote tree: {name}")
    wrong_size = [
        n for n in sorted(set(remote) & local) if (root / n).stat().st_size != remote[n]["size"]
    ]
    for name in wrong_size:
        emit("MANUAL", f"size mismatch: {name}")
    if missing or extra or wrong_size:
        emit("ERROR", "Inventory does not match; re-run the same download command to resume.")
        return 1
    total = sum(entry["size"] for entry in remote.values())
    emit("READY", f"Inventory matches: {len(remote)} files, {total / 1e9:.1f} GB.")

    emit("WAIT", f"Hashing every file with {args.workers} workers...")
    started = time.monotonic()
    records, failures, done = {}, [], 0
    with ThreadPoolExecutor(args.workers) as pool:
        futures = {pool.submit(digest, root / n, remote[n]["size"]): n for n in remote}
        for future in as_completed(futures):
            name = futures[future]
            sha256, blob_id = future.result()
            expected = remote[name]
            ok = (
                sha256 == expected["sha256"]
                if expected["sha256"]
                else blob_id == expected["blob_id"]
            )
            if not ok:
                failures.append(name)
                emit("MANUAL", f"checksum mismatch: {name}")
            records[name] = {"size": expected["size"], "sha256": sha256}
            done += 1
            if done % 20 == 0 or done == len(remote):
                emit("INFO", f"hashed {done}/{len(remote)} files")
    elapsed = time.monotonic() - started
    if failures:
        emit(
            "ERROR",
            f"{len(failures)} files failed verification; delete only those files and resume.",
        )
        return 1
    manifest = args.manifest or root.parent / f"{args.revision}.manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "repository": args.repo,
                "revision": args.revision,
                "directory": str(root),
                "total_bytes": total,
                "verified_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "files": dict(sorted(records.items())),
            },
            indent=1,
        )
    )
    emit(
        "READY",
        f"All {len(records)} files verified in {elapsed:.0f}s ({total / 1e9 / elapsed:.2f} GB/s).",
    )
    emit("INFO", f"Manifest: {manifest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
