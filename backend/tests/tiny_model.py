"""A tiny, randomly initialised qwen4_exp checkpoint built from the real config.

Same conversion pipeline as the served model (affine 4-bit gs64 body, PLE affine 4-bit
gs32 read row by row from disk, 8-bit router gates), so the worker code runs unchanged.
Its outputs are random: tests use it for mechanics (caches, snapshots, IPC, protocol
invariants), never for content.
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
PLE_MARKER = ".ple.ple_embedding.ngram_embedding.shards."


def tiny_config(source: Path) -> dict:
    config = json.loads((source / "config.json").read_text())
    for section in (config, config["text_config"]):
        section.pop("quantization_config", None)
        section.pop("quantization", None)
    text = config["text_config"]
    text.pop("ple_storage", None)
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


def _quant_predicate(path: str, _module):
    from mlx_vlm.utils import skip_multimodal_module

    if skip_multimodal_module(path):
        return False
    if PLE_MARKER in path:
        return {"fallback_group_size": 32, "group_size": 32, "bits": 4, "mode": "affine"}
    if path.endswith("mlp.gate") or path.endswith("shared_expert_gate"):
        return {"group_size": 64, "bits": 8, "mode": "affine"}
    return True


def build(source: Path, root: Path) -> Path:
    """Writes <root>/bf16, <root>/q4 and returns the external-PLE view <root>/q4-extple."""
    import mlx.core as mx
    from mlx.utils import tree_flatten, tree_map
    from mlx_vlm.convert import convert
    from mlx_vlm.models.qwen4_exp import Model, ModelConfig
    from mlx_vlm.models.qwen4_exp.ple_storage import prepare_external_ple_model

    config = tiny_config(source)
    mx.random.seed(0)
    model = Model(ModelConfig.from_dict(config))
    model.update(
        tree_map(
            lambda v: v.astype(mx.bfloat16) if mx.issubdtype(v.dtype, mx.floating) else v,
            model.parameters(),
        )
    )
    bf16 = root / "bf16"
    bf16.mkdir(parents=True)
    weights = dict(tree_flatten(model.parameters()))
    mx.save_safetensors(str(bf16 / "model.safetensors"), weights, metadata={"format": "mlx"})
    (bf16 / "model.safetensors.index.json").write_text(
        json.dumps({"metadata": {}, "weight_map": {k: "model.safetensors" for k in weights}})
    )
    (bf16 / "config.json").write_text(json.dumps(config, indent=1))
    for name in TOKENIZER_FILES:
        if (source / name).is_file():
            shutil.copy2(source / name, bf16 / name)
    quantized = root / "q4"
    convert(
        str(bf16),
        mlx_path=str(quantized),
        quantize=True,
        q_group_size=64,
        q_bits=4,
        q_mode="affine",
        quant_predicate=_quant_predicate,
    )
    for name in TOKENIZER_FILES:
        if (source / name).is_file() and not (quantized / name).exists():
            shutil.copy2(source / name, quantized / name)
    view = root / "q4-extple"
    prepare_external_ple_model(quantized, view)
    return view
