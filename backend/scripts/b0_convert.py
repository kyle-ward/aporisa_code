"""B0-3: convert the official FP8 checkpoint into a candidate MLX format with external PLE.

One-off exploration script (DEVELOPMENT_PLAN.md B0). B1-2 turns the chosen recipe into
`model_weights.sh convert`. For each variant this writes:

  <root>/<name>/          full MLX checkpoint (PLE resident)
  <root>/<name>-extple/   hard-linked view whose PLE table is read row by row from disk
  <root>/<name>-mtp/      MTP draft model (only with --mtp)

and a recipe.json with the source revision, the recipe and the tool versions.

Variants (PLE is always affine 4-bit gs32, the only Q4 layout ple_storage reads; router
gates stay 8-bit affine gs64 like the upstream predicate):
  affine4g64  body affine 4-bit, group 64
  mxfp4       body mxfp4 (group 32)
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

VARIANTS = {
    "affine4g64": {"q_mode": "affine", "q_bits": 4, "q_group_size": 64},
    "mxfp4": {"q_mode": "mxfp4", "q_bits": None, "q_group_size": None},
}
PLE_MARKER = ".ple.ple_embedding.ngram_embedding.shards."
PLE_PARAMS = {"fallback_group_size": 32, "group_size": 32, "bits": 4, "mode": "affine"}
GATE_PARAMS = {"group_size": 64, "bits": 8, "mode": "affine"}
MIN_FREE_BYTES = 130 * 1024**3


def emit(tag: str, message: str) -> None:
    prefix = "ERROR:" if tag == "ERROR" else f"[{tag}]"
    print(f"[Aporisa Code] {prefix} {message}", flush=True)


def quant_predicate(path: str, module) -> bool | dict:
    from mlx_vlm.utils import skip_multimodal_module

    if skip_multimodal_module(path):
        return False
    if PLE_MARKER in path:
        return dict(PLE_PARAMS)
    if path.endswith("mlp.gate") or path.endswith("shared_expert_gate"):
        return dict(GATE_PARAMS)
    return True


def dense_fp8_loading():
    """Make the loader hand raw block-FP8 expert tensors to the qwen4_exp sanitizer.

    By default mlx-vlm's generic FP8 transform turns every `weight_scale_inv` tensor into
    a native MXFP8 layer at load time. nn.quantize then skips those layers, so the experts
    (112 GiB of the checkpoint) would stay 8-bit. With the transform bypassed, the
    sanitizer dequantizes them to dense bf16 and the recipe quantizes them like the rest.
    """
    import mlx_vlm.fp8

    mlx_vlm.fp8.transform_fp8_weights = lambda weights, config, target_quantization=None: (
        weights,
        None,
    )


def check_layout(full: Path, variant: str) -> list[str]:
    """Verifies from safetensors headers that experts and PLE use the recipe's bit widths."""
    import struct

    bits = {"affine4g64": 4, "mxfp4": 4}[variant]
    scale_dtype = {"affine4g64": "BF16", "mxfp4": "U8"}[variant]
    text = json.loads((full / "config.json").read_text())["text_config"]
    problems, seen = [], 0
    header: dict = {}
    for path in sorted(full.glob("*.safetensors")):
        with path.open("rb") as stream:
            header.update(json.loads(stream.read(struct.unpack("<Q", stream.read(8))[0])))
    # A weight and its scales may sit in different shard files; check against the union.
    for key, info in header.items():
        if key == "__metadata__" or not key.endswith(".weight"):
            continue
        prefix = key[: -len(".weight")]
        if ".switch_mlp." in key:
            seen += 1
            in_dim = text["moe_intermediate_size"] if "down_proj" in key else text["hidden_size"]
            if info["dtype"] != "U32" or info["shape"][-1] * 32 // bits != in_dim:
                problems.append(f"{key}: {info['dtype']} {info['shape']} is not {bits}-bit")
            elif header.get(prefix + ".scales", {}).get("dtype") != scale_dtype:
                problems.append(f"{prefix}.scales is not {scale_dtype}")
        elif PLE_MARKER in key and (
            info["dtype"] != "U32" or header.get(prefix + ".scales", {}).get("dtype") != "BF16"
        ):
            problems.append(f"{key}: PLE is not affine 4-bit")
    if not seen:
        problems.append("no expert tensors found")
    return problems


def tensor_bytes(full: Path) -> tuple[int, int]:
    """(all tensor bytes, PLE tensor bytes) from the safetensors headers."""
    import struct

    total = ple = 0
    for path in full.glob("*.safetensors"):
        with path.open("rb") as stream:
            header = json.loads(stream.read(struct.unpack("<Q", stream.read(8))[0]))
        for key, info in header.items():
            if key == "__metadata__":
                continue
            size = info["data_offsets"][1] - info["data_offsets"][0]
            total += size
            ple += size if PLE_MARKER in key else 0
    return total, ple


def tool_versions() -> dict:
    import mlx.core as mx
    import mlx_vlm

    direct_url = (
        Path(mlx_vlm.__file__).parent.parent / "mlx_vlm-0.7.4.dist-info" / "direct_url.json"
    )
    commit = None
    if direct_url.is_file():
        commit = json.loads(direct_url.read_text()).get("vcs_info", {}).get("commit_id")
    return {"mlx": mx.__version__, "mlx_vlm": mlx_vlm.__version__, "mlx_vlm_commit": commit}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--source", required=True, type=Path, help="official FP8 checkpoint directory"
    )
    parser.add_argument("--variant", required=True, choices=sorted(VARIANTS))
    parser.add_argument("--root", required=True, type=Path, help="parent directory of the outputs")
    parser.add_argument("--name", help="default: Qwen3.8-Flash-Next--<variant>")
    parser.add_argument("--mtp", action="store_true", help="also extract the MTP draft model")
    parser.add_argument(
        "--finish",
        action="store_true",
        help="the full checkpoint exists: skip conversion, only check it and build the view",
    )
    args = parser.parse_args()

    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    source = args.source.resolve()
    name = args.name or f"Qwen3.8-Flash-Next--{args.variant}"
    full, view, mtp = (
        args.root.resolve() / suffix for suffix in (name, f"{name}-extple", f"{name}-mtp")
    )
    for target in (view,) if args.finish else (full, view, *([mtp] if args.mtp else [])):
        if target.exists():
            emit(
                "MANUAL",
                f"Output already exists; remove it deliberately before re-running: {target}",
            )
            return 1
    if not (source / "config.json").is_file():
        emit("MANUAL", f"Not a checkpoint directory: {source}")
        return 1
    args.root.mkdir(parents=True, exist_ok=True)
    if args.finish and not (full / "config.json").is_file():
        emit("MANUAL", f"--finish needs an existing converted checkpoint: {full}")
        return 1
    free = shutil.disk_usage(args.root).free
    if not args.finish and free < MIN_FREE_BYTES:
        emit("MANUAL", f"Only {free / 1024**3:.0f} GiB free; one variant needs about 130 GiB.")
        return 1

    import mlx.core as mx
    from mlx_vlm.convert import convert
    from mlx_vlm.models.qwen4_exp.ple_storage import prepare_external_ple_model

    recipe = {
        "variant": args.variant,
        **VARIANTS[args.variant],
        "ple": {k: v for k, v in PLE_PARAMS.items() if k != "fallback_group_size"},
        "router_gates": GATE_PARAMS,
        "vision": "unquantized",
        "dtype": "bfloat16",
    }
    emit("INFO", f"Recipe: {json.dumps(recipe)}")
    if not args.finish:
        emit("WAIT", f"Converting {source.name} -> {full} (this takes a long time)...")
    dense_fp8_loading()
    started = time.monotonic()
    if not args.finish:
        convert(
            str(source),
            mlx_path=str(full),
            quantize=True,
            q_group_size=VARIANTS[args.variant]["q_group_size"],
            q_bits=VARIANTS[args.variant]["q_bits"],
            q_mode=VARIANTS[args.variant]["q_mode"],
            quant_predicate=quant_predicate,
            mtp=args.mtp,
            mtp_output=str(mtp) if args.mtp else None,
        )
    converted = time.monotonic()
    if not args.finish:
        emit(
            "READY",
            f"Converted in {(converted - started) / 60:.1f} min; peak MLX memory "
            f"{mx.get_peak_memory() / 1024**3:.1f} GiB.",
        )

    problems = check_layout(full, args.variant)
    for problem in problems[:10]:
        emit("MANUAL", problem)
    if problems:
        emit("ERROR", f"{len(problems)} tensors do not match the recipe; the output is not usable.")
        return 1
    emit("READY", "Expert and PLE tensors match the recipe's bit widths.")

    emit("WAIT", "Building the external-PLE view (hard links, no copy)...")
    prepare_external_ple_model(full, view)

    provenance = {
        "source": {"directory": str(source)},
        "recipe": recipe,
        "tools": tool_versions(),
        "converted_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "convert_minutes": None if args.finish else round((converted - started) / 60, 1),
    }
    manifest = source.parent / f"{source.name}.manifest.json"
    if manifest.is_file():
        data = json.loads(manifest.read_text())
        provenance["source"] = {
            "repository": data["repository"],
            "revision": data["revision"],
            "directory": str(source),
        }
    for target in (full, view, *([mtp] if args.mtp and mtp.exists() else [])):
        (target / "recipe.json").write_text(json.dumps(provenance, indent=1) + "\n")
        # Qwen Community License 1.0 section 1: copies and derivatives carry the notice.
        # mlx_vlm.convert copies only *.json / *.py, so the license travels explicitly.
        if (source / "LICENSE").is_file():
            shutil.copy2(source / "LICENSE", target / "LICENSE")

    total, ple = tensor_bytes(full)
    emit("READY", f"Full checkpoint: {total / 1024**3:.1f} GiB of tensors.")
    emit(
        "READY",
        f"External-PLE view: resident weights {(total - ple) / 1024**3:.1f} GiB "
        f"(PLE read from disk: {ple / 1024**3:.1f} GiB, shared with the full checkpoint).",
    )
    if args.mtp:
        emit(
            "READY" if mtp.exists() else "MANUAL",
            f"MTP drafter: {mtp if mtp.exists() else 'not produced; see output above'}",
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
