#!/usr/bin/env python3
"""One-time: register the B0-converted artifacts as identities (DEVELOPMENT_PLAN 14.6, decision 2).

    backend/.venv/bin/python scripts/migrate_b0_artifacts.py [--dry-run]

B0's scripts/b0_convert.py left .runtime/models/Qwen3.8-Flash-Next--affine4g64 (full
checkpoint), its -extple view and -mtp. This script, without reconverting and without extra
disk (hard links on the same volume):

1. checks that the B0 recipe.json matches the packaged recipe and the pinned tools;
2. assembles the self-contained served directory (view + the PLE files it reads) and the MTP
   directory under .runtime/weight-staging, computes their full SHA256 inventories;
3. publishes them to .runtime/models/<folder>/<recipe digest>/ with identity records whose
   provenance names the upstream repository and revision (from the B0 download manifest).

The B0 directories are left untouched; afterwards delete them with model_weights.sh. Removed
when B1 closes, like local_llm's migrate_weight_metadata.py after its migration.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend" / "src"))

from aporisa_backend.console import emit  # noqa: E402
from aporisa_backend.lifecycle import recipes  # noqa: E402
from aporisa_backend.lifecycle.assets import (  # noqa: E402
    SCHEMA,
    Layout,
    asset_lock,
    atomic_json,
    folder_for_identity,
    inventory,
    namespace_lock,
    records,
)

RECIPE = "affine4g64"
IDENTITY = "Qwen3.8-Flash-Next-affine4g64"
MTP_IDENTITY = "Qwen3.8-Flash-Next-affine4g64-mtp"
SOURCE_IDENTITY = "Qwen3.8-Flash-Next-FP8"
B0_FULL = "Qwen3.8-Flash-Next--affine4g64"
B0_MTP = "Qwen3.8-Flash-Next--affine4g64-mtp"
B0_SOURCE_FOLDER = "Qwen--Qwen3.8-Flash-Next-FP8"


def b0_matches(b0: dict, tools: dict) -> list[str]:
    """Differences between the B0 recipe.json and the packaged recipe plus current tools."""
    spec = recipes.RECIPES[RECIPE]
    recipe = b0.get("recipe", {})
    expected = {
        "q_mode": spec["body"]["mode"],
        "q_bits": spec["body"]["bits"],
        "q_group_size": spec["body"]["group_size"],
        "ple": spec["ple"],
        "router_gates": spec["router_gates"],
        "vision": spec["vision"],
        "dtype": spec["dtype"],
    }
    problems = [f"recipe.{k}" for k, v in expected.items() if recipe.get(k) != v]
    b0_tools = b0.get("tools", {})
    problems += [f"tools.{k}" for k in ("mlx", "mlx_vlm_commit") if b0_tools.get(k) != tools.get(k)]
    return problems


def hardlink_tree(source: Path, target: Path) -> None:
    target.mkdir(parents=True)
    for path in sorted(source.iterdir()):
        if path.is_file() and not path.is_symlink():
            os.link(path, target / path.name)


def migrate(layout: Layout, *, dry_run: bool) -> int:
    full = layout.models / B0_FULL
    drafter = layout.models / B0_MTP
    if not (full / "recipe.json").is_file():
        emit("MANUAL", f"No B0 checkpoint with recipe.json at {full}; nothing to migrate.")
        return 1
    b0 = json.loads((full / "recipe.json").read_text())
    tools = recipes.tool_versions()
    if problems := b0_matches(b0, tools):
        emit("MANUAL", f"B0 recipe differs from the packaged recipe: {', '.join(problems)}.")
        return 1
    if layout_problems := recipes.check_layout(full, recipes.RECIPES[RECIPE]):
        emit("MANUAL", f"B0 tensors do not match the recipe ({len(layout_problems)} problems).")
        return 1
    upstream = b0.get("source", {})
    if not upstream.get("repository") or not upstream.get("revision"):
        emit("MANUAL", "The B0 recipe does not name the upstream repository and revision.")
        return 1
    digest = recipes.recipe_digest(RECIPE, tools)
    version = digest[:16]
    base = {
        "kind": "convert",
        "recipe": RECIPE,
        "recipe_digest": digest,
        "spec": recipes.RECIPES[RECIPE],
        "tools": tools,
        "from": {
            "identity": SOURCE_IDENTITY,
            "directory": B0_SOURCE_FOLDER,
            "version": upstream["revision"],
            "repository": upstream["repository"],
            "revision": upstream["revision"],
        },
        "migrated_from": "b0",
    }
    outputs = [("model", IDENTITY, full)]
    if drafter.is_dir():
        outputs.append(("mtp", MTP_IDENTITY, drafter))
    emit("INFO", f"Recipe {RECIPE} verified; version {version}; outputs: {len(outputs)}.")
    if dry_run:
        for part, identity, _ in outputs:
            emit("INFO", f"Would register {identity} ({part}) at {folder_for_identity(identity)}.")
        return 0
    for part, identity, origin in outputs:
        folder = folder_for_identity(identity)
        with namespace_lock(layout):
            if any(r["identity"] == identity for r in records(layout)):
                emit("INFO", f"{identity} is already registered; skipped.")
                continue
        with asset_lock(layout, folder, exclusive=True):
            staging = layout.staging / folder
            built = staging / "migrated"
            if staging.exists():
                emit("MANUAL", f"Staging exists at {staging}; remove it deliberately and retry.")
                return 1
            if part == "model":
                recipes.build_self_contained(origin, built)
            else:
                hardlink_tree(origin, built)
            provenance = {
                **base,
                "output": part,
                "identity": identity,
                "converted_at": b0.get("converted_at"),
                "migrated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            }
            (built / "recipe.json").unlink(missing_ok=True)  # a copy of B0's, replaced
            atomic_json(built / "recipe.json", provenance)
            emit("WAIT", f"Computing the SHA256 inventory of {identity}...")
            files = inventory(built)
            record = {
                "schema": SCHEMA,
                "identity": identity,
                "directory": folder,
                "version": version,
                "state": "converting",
                "source": {**base, "output": part},
                "files": files,
            }
            record_path = layout.record(folder)
            atomic_json(record_path, record)
            destination = layout.models / folder
            destination.mkdir(parents=True, exist_ok=True)
            built.rename(destination / version)
            record["state"] = "ready"
            atomic_json(record_path, record)
            staging.rmdir()
            emit("READY", f"Registered {identity}: {folder}/{version} ({len(files)} files).")
    emit("INFO", "The B0 directories are untouched and now redundant (hard links keep the data).")
    emit("INFO", f"Remove them with: ./model_weights.sh delete {B0_FULL} (and -extple, -mtp).")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="check only; change nothing")
    args = parser.parse_args()
    os.umask(0o077)
    return migrate(Layout(ROOT), dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
