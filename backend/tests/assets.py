"""Local model files some tests read (never committed: tokenizer.json alone is 12 MB).

The directory is found the way the service finds it: the pointed identity's asset record.
Tests that need it skip with the reason when it is absent; on the Studio they run.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from aporisa_backend.configs.models import active_pointer
from aporisa_backend.lifecycle.assets import Layout, resolve_identity

ROOT = Path(__file__).resolve().parents[2]


def _served_directory() -> Path:
    try:
        layout = Layout(ROOT)
        return layout.weights(resolve_identity(layout, active_pointer()[1]))
    except (ValueError, OSError):
        return ROOT / ".runtime" / "models" / "(pointed identity not registered)"


MODEL_DIR = _served_directory()

requires_tokenizer = pytest.mark.skipif(
    not (MODEL_DIR / "tokenizer.json").is_file(),
    reason=f"local tokenizer files not found under {MODEL_DIR}",
)
