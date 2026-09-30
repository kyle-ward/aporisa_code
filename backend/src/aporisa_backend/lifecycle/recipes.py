"""Conversion recipes: official FP8 checkpoint -> served MLX artifact (14.6, decisions 1 and 4).

Moved from the B0 conversion script (removed at B1 close; see commit c89d1b2). One recipe
produces:

- the served artifact: one self-contained directory with the external-PLE view (resident
  weights, index without PLE keys, config with `ple_storage`) plus the PLE shard files it
  reads, `ple-store.json` pointing at the directory itself;
- optionally the MTP draft model, as its own directory.

Pitfalls this module encodes (B0-3):
- mlx-vlm's generic FP8 loader turns block-FP8 experts into native MXFP8 layers, which
  nn.quantize then skips, leaving the experts 8-bit. The transform is bypassed so the
  qwen4_exp sanitizer dequantizes them to bf16 and the recipe quantizes them.
- PLE rows are 160 wide: affine group 64 cannot represent them; PLE uses group 32.
- A weight and its scales may sit in different shard files; the layout check merges headers.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import struct
from contextlib import contextmanager
from pathlib import Path

PLE_MARKER = ".ple.ple_embedding.ngram_embedding.shards."
LAYOUT = "external_ple_self_contained_v1"

RECIPES: dict[str, dict] = {
    "affine4g64": {
        "body": {"mode": "affine", "bits": 4, "group_size": 64},
        "ple": {"mode": "affine", "bits": 4, "group_size": 32},
        "router_gates": {"mode": "affine", "bits": 8, "group_size": 64},
        "vision": "unquantized",
        "dtype": "bfloat16",
    },
}
SCALE_DTYPE = {"affine": "BF16", "mxfp4": "U8"}


def tool_versions() -> dict:
    import mlx.core as mx
    import mlx_vlm

    commit = None
    for info in Path(mlx_vlm.__file__).parent.parent.glob("mlx_vlm-*.dist-info"):
        direct = info / "direct_url.json"
        if direct.is_file():
            commit = json.loads(direct.read_text()).get("vcs_info", {}).get("commit_id")
    return {"mlx": mx.__version__, "mlx_vlm": mlx_vlm.__version__, "mlx_vlm_commit": commit}


def recipe_digest(name: str, tools: dict) -> str:
    """Identifies an output: recipe, layout and the exact conversion tools."""
    body = {"recipe": name, "spec": RECIPES[name], "layout": LAYOUT, "tools": tools}
    return hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()


def quant_predicate(spec: dict):
    ple = {**spec["ple"], "fallback_group_size": spec["ple"]["group_size"]}

    def predicate(path: str, _module):
        from mlx_vlm.utils import skip_multimodal_module

        if skip_multimodal_module(path):
            return False
        if PLE_MARKER in path:
            return dict(ple)
        if path.endswith("mlp.gate") or path.endswith("shared_expert_gate"):
            return dict(spec["router_gates"])
        return True

    return predicate


@contextmanager
def dense_fp8_loading():
    """Hands raw block-FP8 expert tensors to the qwen4_exp sanitizer (see module notes)."""
    import mlx_vlm.fp8

    original = mlx_vlm.fp8.transform_fp8_weights
    mlx_vlm.fp8.transform_fp8_weights = lambda weights, config, target_quantization=None: (
        weights,
        None,
    )
    try:
        yield
    finally:
        mlx_vlm.fp8.transform_fp8_weights = original


def _headers(directory: Path) -> dict:
    header: dict = {}
    for path in sorted(directory.glob("*.safetensors")):
        with path.open("rb") as stream:
            header.update(json.loads(stream.read(struct.unpack("<Q", stream.read(8))[0])))
    header.pop("__metadata__", None)
    return header


def check_layout(full: Path, spec: dict) -> list[str]:
    """Problems found in the safetensors headers: experts and PLE must match the recipe."""
    body = spec["body"]
    text = json.loads((full / "config.json").read_text())["text_config"]
    header = _headers(full)
    problems, experts = [], 0
    for key, info in header.items():
        if not key.endswith(".weight"):
            continue
        prefix = key[: -len(".weight")]
        scales = header.get(prefix + ".scales", {}).get("dtype")
        if ".switch_mlp." in key:
            experts += 1
            in_dim = text["moe_intermediate_size"] if "down_proj" in key else text["hidden_size"]
            if info["dtype"] != "U32" or info["shape"][-1] * 32 // body["bits"] != in_dim:
                problems.append(f"{key}: {info['dtype']} {info['shape']} is not {body['bits']}-bit")
            elif scales != SCALE_DTYPE[body["mode"]]:
                problems.append(f"{prefix}.scales is not {SCALE_DTYPE[body['mode']]}")
        elif PLE_MARKER in key and (info["dtype"] != "U32" or scales != "BF16"):
            problems.append(f"{key}: PLE is not affine 4-bit")
    if not experts:
        problems.append("no expert tensors found")
    return problems


def build_self_contained(full: Path, target: Path) -> None:
    """External-PLE view of `full` plus the PLE files it reads, all hard links (same disk)."""
    from mlx_vlm.models.qwen4_exp.ple_storage import prepare_external_ple_model

    prepare_external_ple_model(full, target)
    manifest_path = target / "ple-store.json"
    manifest = json.loads(manifest_path.read_text())
    names = {
        shard[name]["file"]
        for shard in manifest["shards"]
        for name in ("weight", "scales", "biases", "global_scales")
        if name in shard
    }
    for name in sorted(names):
        if not (target / name).exists():
            os.link(full / name, target / name)
    manifest["source_root"] = "."
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    provenance_path = target / "EXTERNAL_PLE.json"
    provenance = json.loads(provenance_path.read_text())
    provenance["source_model"] = "."
    provenance["layout"] = LAYOUT
    provenance_path.write_text(json.dumps(provenance, indent=2) + "\n")


def quantize(source: Path, recipe: str, full: Path, *, mtp_output: Path | None = None) -> list[str]:
    """mlx-vlm conversion of the FP8 checkpoint into `full` (PLE resident); returns the
    layout problems (empty when the tensors match the recipe)."""
    from mlx_vlm.convert import convert as mlx_convert

    spec = RECIPES[recipe]
    with dense_fp8_loading():
        mlx_convert(
            str(source),
            mlx_path=str(full),
            quantize=True,
            q_group_size=spec["body"]["group_size"],
            q_bits=spec["body"]["bits"],
            q_mode=spec["body"]["mode"],
            quant_predicate=quant_predicate(spec),
            mtp=mtp_output is not None,
            mtp_output=str(mtp_output) if mtp_output is not None else None,
        )
    return check_layout(full, spec)


def convert(
    source: Path, recipe: str, work: Path, *, mtp: bool, emit=lambda tag, message: None
) -> tuple[Path, Path | None]:
    """Converts `source` (official FP8 checkpoint) under `work`; returns (served, mtp) dirs.

    `work` must be empty and on the same disk as the final destination.
    """
    import mlx.core as mx

    full, served, drafter = work / "full", work / "served", work / "mtp"
    emit("WAIT", f"Converting with recipe {recipe}; this takes a long time for the real model.")
    problems = quantize(source, recipe, full, mtp_output=drafter if mtp else None)
    emit("INFO", f"Conversion finished; peak MLX memory {mx.get_peak_memory() / 1024**3:.1f} GiB.")
    if problems:
        raise ValueError(f"{len(problems)} tensors do not match the recipe; output not usable")
    build_self_contained(full, served)
    shutil.rmtree(full)  # every file the served artifact needs is hard-linked into it
    drafter_out = drafter if mtp and drafter.is_dir() else None
    # Qwen Community License 1.0: copies and derivatives carry the notice.
    if (source / "LICENSE").is_file():
        for directory in (served, drafter_out):
            if directory is not None:
                shutil.copy2(source / "LICENSE", directory / "LICENSE")
    return served, drafter_out
