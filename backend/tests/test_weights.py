"""Weight maintenance: records, leases, inventories, download (fake Hub), convert, migration.

No network: the Hub client is replaced by a local fake. convert and the B0 migration run on
the tiny FP8 checkpoint through the real conversion pipeline.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import shutil
import sys
import types
from pathlib import Path

import pytest
from conftest import ALIAS, worker_init

from aporisa_backend.lifecycle import assets, recipes, weights
from aporisa_backend.lifecycle.assets import Layout

REVISION = "a" * 40
ROOT = Path(__file__).resolve().parents[2]


def download_record(folder="Owner--Model", identity="Owner-Model", files=None, **overrides):
    return {
        "schema": 1,
        "identity": identity,
        "directory": folder,
        "version": REVISION,
        "state": "ready",
        "source": {"kind": "download", "repository": "Owner/Model", "revision": REVISION},
        "files": files or {"config.json": {"size": 2, "sha256": "0" * 64}},
        **overrides,
    }


def test_record_validation():
    assets.validate_record(download_record(), "Owner--Model")
    with pytest.raises(ValueError):
        assets.validate_record(download_record(version="b" * 40), "Owner--Model")
    with pytest.raises(ValueError):
        assets.validate_record(
            download_record(files={"../x": {"size": 1, "sha256": "0" * 64}}), "Owner--Model"
        )
    with pytest.raises(ValueError):
        assets.validate_record(download_record(), "Other")
    convert = {
        **download_record(folder="M", identity="M"),
        "version": "c" * 16,
        "source": {
            "kind": "convert",
            "recipe": "affine4g64",
            "recipe_digest": "c" * 64,
            "spec": {},
            "tools": {},
            "from": {"identity": "Up", "repository": "Owner/Model", "revision": REVISION},
        },
    }
    assets.validate_record(convert, "M")
    del convert["source"]["from"]["revision"]
    with pytest.raises(ValueError):
        assets.validate_record(convert, "M")


def test_folder_rules():
    assert assets.folder_for_repository("Qwen/Qwen3.8-Flash-Next-FP8") == (
        "Qwen--Qwen3.8-Flash-Next-FP8"
    )
    assert assets.folder_for_identity("Qwen3.8 Flash/x") == "Qwen3.8-Flash-x"
    for bad in ("../x", "a/b", "", ".hidden"):
        with pytest.raises(ValueError):
            assets.safe_folder(bad)


def test_leases(tmp_path):
    layout = Layout(tmp_path)
    with assets.asset_lock(layout, "M"):
        with assets.asset_lock(layout, "M"):
            pass  # shared leases coexist
        with pytest.raises(ValueError, match="in use"):
            with assets.asset_lock(layout, "M", exclusive=True):
                pass
    with assets.asset_lock(layout, "M", exclusive=True):
        assert assets.lease_active(layout, "M") is True
    assert assets.lease_active(layout, "M") is False


def test_inventory_quick_and_full(tmp_path):
    directory = tmp_path / "w"
    directory.mkdir()
    (directory / "config.json").write_text("{}")
    (directory / "model.safetensors").write_bytes(b"abcd" * 1000)
    files = assets.inventory(directory)
    assets.verify_inventory(directory, files, full=True)
    data = bytearray((directory / "model.safetensors").read_bytes())
    data[10] ^= 1
    (directory / "model.safetensors").write_bytes(bytes(data))
    assets.verify_inventory(directory, files, full=False)  # same size: only prepare notices
    with pytest.raises(ValueError, match="checksum"):
        assets.verify_inventory(directory, files, full=True)
    (directory / "config.json").write_text("[]")
    with pytest.raises(ValueError, match="checksum"):
        assets.verify_inventory(directory, files, full=False)
    (directory / "extra").write_text("x")
    with pytest.raises(ValueError, match="inventory"):
        assets.verify_inventory(directory, files, full=False)


# --- download ----------------------------------------------------------------------------------


class FakeHub:
    """model_info / snapshot_download / hf_hub_download over an in-memory repository."""

    FILES = {"config.json": b'{"a": 1}', "model.safetensors": b"\x00" * 4096}

    def __init__(self):
        self.downloads = 0

    def sibling(self, name, data):
        lfs = None
        blob = None
        if name.endswith(".safetensors"):
            lfs = types.SimpleNamespace(sha256=hashlib.sha256(data).hexdigest())
        else:
            blob = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
        return types.SimpleNamespace(rfilename=name, size=len(data), lfs=lfs, blob_id=blob)

    def module(self):
        hub = self

        class HfApi:
            def __init__(self, token=None):
                pass

            def model_info(self, repository, revision=None, files_metadata=False):
                siblings = [hub.sibling(n, d) for n, d in hub.FILES.items()]
                return types.SimpleNamespace(sha=REVISION, siblings=siblings)

        def snapshot_download(repo_id, revision, local_dir, token, max_workers):
            hub.downloads += 1
            Path(local_dir).mkdir(parents=True, exist_ok=True)
            for name, data in hub.FILES.items():
                (Path(local_dir) / name).write_bytes(data)

        def hf_hub_download(**kwargs):
            (Path(kwargs["local_dir"]) / kwargs["filename"]).write_bytes(
                hub.FILES[kwargs["filename"]]
            )

        return types.SimpleNamespace(
            HfApi=HfApi, snapshot_download=snapshot_download, hf_hub_download=hf_hub_download
        )


@pytest.fixture
def hub(monkeypatch):
    fake = FakeHub()
    monkeypatch.setitem(sys.modules, "huggingface_hub", fake.module())
    monkeypatch.setattr(weights, "configure_transport", lambda staging: None)
    return fake


def test_download_publishes_verifies_and_reuses(tmp_path, hub):
    layout = Layout(tmp_path)
    weights.download(layout, "Owner/Model", identity="Owner-Model")
    record = assets.read_record(layout.record("Owner--Model"))
    assert record["state"] == "ready" and record["version"] == REVISION
    assert (layout.models / "Owner--Model" / REVISION / "config.json").is_file()
    assert not (layout.staging / "Owner--Model").exists()
    weights.download(layout, "Owner/Model", identity="Owner-Model")
    assert hub.downloads == 1  # verified offline, nothing downloaded again
    with pytest.raises(ValueError, match="another source"):
        weights.download(layout, "Owner/Other", identity="Owner-Model")
    assert weights.list_weights(layout) == [
        ("Owner--Model", "Owner-Model", "present (not verified)")
    ]
    with assets.asset_lock(layout, "Owner--Model"):
        with pytest.raises(ValueError, match="in use"):
            weights.delete(layout, "Owner--Model")
    weights.delete(layout, "Owner--Model")
    assert weights.list_weights(layout) == []


def test_download_adopts_an_existing_directory(tmp_path, hub):
    layout = Layout(tmp_path)
    existing = layout.models / "Owner--Model" / REVISION
    existing.mkdir(parents=True)
    for name, data in FakeHub.FILES.items():
        (existing / name).write_bytes(data)
    with pytest.raises(ValueError, match="--revision"):
        weights.download(layout, "Owner/Model", identity="Owner-Model")
    weights.download(layout, "Owner/Model", identity="Owner-Model", revision=REVISION)
    assert hub.downloads == 0
    assert assets.read_record(layout.record("Owner--Model"))["state"] == "ready"


# --- convert and migration (tiny FP8) ----------------------------------------------------------


def register_upstream(layout: Layout, checkpoint: Path, identity="Tiny-FP8") -> dict:
    folder = assets.folder_for_repository("Tiny/FP8")
    target = layout.models / folder / REVISION
    target.parent.mkdir(parents=True)
    shutil.copytree(checkpoint, target)
    record = {
        "schema": 1,
        "identity": identity,
        "directory": folder,
        "version": REVISION,
        "state": "ready",
        "source": {"kind": "download", "repository": "Tiny/FP8", "revision": REVISION},
        "files": assets.inventory(target),
    }
    assets.atomic_json(layout.record(folder), record)
    return record


def load_and_warm(directory: Path) -> None:
    from aporisa_backend.engine import runtime

    engine = runtime.load(worker_init(directory))
    runtime.warmup(engine, ALIAS)
    assert engine.info["ple_prefetch"]


def test_convert_produces_a_self_contained_identity(tmp_path, tiny_fp8_dir):
    layout = Layout(tmp_path)
    upstream = register_upstream(layout, tiny_fp8_dir)
    weights.convert(layout, "Tiny-FP8", recipe="affine4g64", identity="Tiny-affine4g64")
    record = assets.resolve_identity(layout, "Tiny-affine4g64")
    source = record["source"]
    assert source["kind"] == "convert" and source["from"]["revision"] == REVISION
    assert record["version"] == source["recipe_digest"][:16]
    served = layout.weights(record)
    assets.verify_inventory(served, record["files"], full=True)
    assert json.loads((served / "ple-store.json").read_text())["source_root"] == "."
    assert json.loads((served / "recipe.json").read_text())["identity"] == "Tiny-affine4g64"
    assert (served / "LICENSE").is_file()
    assert not (layout.staging / record["directory"]).exists()
    weights.convert(layout, "Tiny-FP8", recipe="affine4g64", identity="Tiny-affine4g64")
    # The served identity no longer needs its source: delete it, then load and warm up.
    weights.delete(layout, upstream["directory"])
    load_and_warm(served)


def load_migration():
    spec = importlib.util.spec_from_file_location(
        "migrate_b0_artifacts", ROOT / "scripts" / "migrate_b0_artifacts.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_b0_migration_registers_without_reconverting(tmp_path, tiny_fp8_dir):
    migration = load_migration()
    layout = Layout(tmp_path)
    full = layout.models / migration.B0_FULL
    drafter = layout.models / migration.B0_MTP
    assert recipes.quantize(tiny_fp8_dir, "affine4g64", full) == []
    tools = recipes.tool_versions()
    spec = recipes.RECIPES["affine4g64"]
    (full / "recipe.json").write_text(
        json.dumps(
            {
                "source": {"repository": "Tiny/FP8", "revision": REVISION},
                "recipe": {
                    "variant": "affine4g64",
                    "q_mode": "affine",
                    "q_bits": 4,
                    "q_group_size": 64,
                    "ple": spec["ple"],
                    "router_gates": spec["router_gates"],
                    "vision": "unquantized",
                    "dtype": "bfloat16",
                },
                "tools": tools,
                "converted_at": "2026-09-30T14:55:20+0800",
            }
        )
    )
    drafter.mkdir()
    (drafter / "model.safetensors").write_bytes(b"\x01" * 64)
    (drafter / "config.json").write_text("{}")
    before = sorted(p.name for p in full.iterdir())

    assert migration.migrate(layout, dry_run=True) == 0
    assert assets.records(layout) == []
    assert migration.migrate(layout, dry_run=False) == 0

    served = assets.resolve_identity(layout, migration.IDENTITY)
    mtp = assets.resolve_identity(layout, migration.MTP_IDENTITY)
    assert served["version"] == recipes.recipe_digest("affine4g64", tools)[:16]
    assert served["source"]["migrated_from"] == "b0" and mtp["source"]["output"] == "mtp"
    for record in (served, mtp):
        assets.verify_inventory(layout.weights(record), record["files"], full=True)
    assert sorted(p.name for p in full.iterdir()) == before  # B0 directories untouched
    assert (full / "model.safetensors").stat().st_nlink >= 2  # hard links, no copy
    assert migration.migrate(layout, dry_run=False) == 0  # idempotent
    weights.delete(layout, migration.B0_FULL)
    weights.delete(layout, migration.B0_MTP)
    load_and_warm(layout.weights(served))
