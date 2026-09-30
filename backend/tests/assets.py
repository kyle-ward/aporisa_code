"""Local model files some tests read (never committed: tokenizer.json alone is 12 MB).

Tests that need them skip with the reason when they are absent; on the Studio they run.
"""

from __future__ import annotations

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
MODEL_DIR = ROOT / ".runtime" / "models" / "Qwen3.8-Flash-Next--affine4g64-extple"

requires_tokenizer = pytest.mark.skipif(
    not (MODEL_DIR / "tokenizer.json").is_file(),
    reason=f"local tokenizer files not found under {MODEL_DIR}",
)
