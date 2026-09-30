"""B0 script harness: a tiny, randomly initialised qwen4_exp model built from the real config.

Only for checking the B0 scripts' own logic (cache snapshots, positions, conversion flow)
without loading 70 GB of weights. Numbers from it say nothing about the real model.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

TOKENIZER_FILES = (
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
    "merges.txt",
    "chat_template.jinja",
    "generation_config.json",
    "preprocessor_config.json",
    "video_preprocessor_config.json",
)


def tiny_config(source: Path) -> dict:
    config = json.loads((source / "config.json").read_text())
    config.pop("quantization_config", None)
    text = config["text_config"]
    text.pop("quantization_config", None)
    text.update(
        hidden_size=256,
        num_hidden_layers=8,
        num_attention_heads=4,
        num_key_value_heads=2,
        head_dim=64,
        linear_num_value_heads=4,
        linear_num_key_heads=2,
        linear_key_head_dim=32,
        linear_value_head_dim=32,
        num_experts=8,
        num_experts_per_tok=2,
        moe_intermediate_size=64,
        shared_expert_intermediate_size=64,
        hc_lowrank=32,
        ple_embed_dim=2560,
        ngram_vocab_size_base=4096,
        split_ngram_parts=4,
        indexer_n_heads=2,
        indexer_head_dim=32,
        indexer_budget=64,
        layer_types=(["linear_attention"] * 3 + ["full_attention"]) * 2,
    )
    config["vision_config"].update(
        depth=1, hidden_size=64, intermediate_size=64, num_heads=2, out_hidden_size=256
    )
    return config


def build_tiny_model(source: Path):
    import mlx.core as mx
    from mlx_vlm.models.qwen4_exp import Model, ModelConfig

    mx.random.seed(0)
    model = Model(ModelConfig.from_dict(tiny_config(source)))
    mx.eval(model.parameters())
    return model


def write_tiny_checkpoint(source: Path, target: Path) -> Path:
    """Saves a bf16 tiny checkpoint that mlx_vlm.convert and load() accept."""
    import mlx.core as mx
    from mlx.utils import tree_flatten, tree_map

    model = build_tiny_model(source)
    model.update(
        tree_map(
            lambda v: v.astype(mx.bfloat16) if mx.issubdtype(v.dtype, mx.floating) else v,
            model.parameters(),
        )
    )
    target.mkdir(parents=True, exist_ok=False)
    weights = dict(tree_flatten(model.parameters()))
    mx.save_safetensors(str(target / "model.safetensors"), weights, metadata={"format": "mlx"})
    (target / "model.safetensors.index.json").write_text(
        json.dumps({"metadata": {}, "weight_map": {k: "model.safetensors" for k in weights}})
    )
    (target / "config.json").write_text(json.dumps(tiny_config(source), indent=1))
    for name in TOKENIZER_FILES:
        if (source / name).is_file():
            shutil.copy2(source / name, target / name)
    return target


def write_tiny_fp8_checkpoint(source: Path, target: Path) -> Path:
    """Like write_tiny_checkpoint, but experts use the official block-FP8 layout.

    Per-expert `...mlp.experts.<e>.<proj>.weight` E4M3 bytes plus 128x128 `weight_scale_inv`
    blocks, as in Qwen/Qwen3.8-Flash-Next-FP8, so the loader's FP8 path is exercised.
    """
    import mlx.core as mx
    from mlx.utils import tree_flatten, tree_map

    model = build_tiny_model(source)
    model.update(
        tree_map(
            lambda v: v.astype(mx.bfloat16) if mx.issubdtype(v.dtype, mx.floating) else v,
            model.parameters(),
        )
    )
    weights = dict(tree_flatten(model.parameters()))
    block = 128
    for key in [k for k in weights if ".mlp.switch_mlp." in k and k.endswith(".weight")]:
        stacked = weights.pop(key).astype(mx.float32)
        layer = key.split(".layers.")[1].split(".")[0]
        projection = key.split(".switch_mlp.")[1].split(".")[0]
        for expert in range(stacked.shape[0]):
            w = stacked[expert]
            rows, cols = w.shape
            br, bc = -(-rows // block), -(-cols // block)
            padded = mx.pad(w, ((0, br * block - rows), (0, bc * block - cols)))
            blocks = padded.reshape(br, block, bc, block)
            scale = mx.maximum(mx.abs(blocks).max(axis=(1, 3)), 1e-8) / 448.0
            q = (blocks / scale[:, None, :, None]).reshape(br * block, bc * block)[:rows, :cols]
            name = f"model.language_model.layers.{layer}.mlp.experts.{expert}.{projection}.weight"
            weights[name] = mx.to_fp8(q)
            weights[name + "_scale_inv"] = scale
    target.mkdir(parents=True, exist_ok=False)
    mx.save_safetensors(str(target / "model.safetensors"), weights, metadata={"format": "pt"})
    (target / "model.safetensors.index.json").write_text(
        json.dumps({"metadata": {}, "weight_map": {k: "model.safetensors" for k in weights}})
    )
    config = tiny_config(source)
    config["quantization_config"] = {
        "quant_method": "fp8",
        "activation_scheme": "dynamic",
        "weight_block_size": [128, 128],
    }
    (target / "config.json").write_text(json.dumps(config, indent=1))
    for name in TOKENIZER_FILES:
        if (source / name).is_file():
            shutil.copy2(source / name, target / name)
    return target
