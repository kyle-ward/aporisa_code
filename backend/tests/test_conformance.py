"""The frontend's wire conformance suite against the real gateway and the fake worker.

The same W01-W26 cases also judge the real backend (DEVELOPMENT_PLAN.md B1 acceptance).
Needs the project's Node and npm dependencies (./frontend.sh prepare); skipped otherwise.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest
from conftest import ALIAS, API_KEY

FRONTEND = Path(__file__).resolve().parents[2] / "aporisa_code"
NODE = FRONTEND / ".tools" / "node" / "bin" / "node"


@pytest.mark.skipif(
    not NODE.is_file() or not (FRONTEND / "node_modules").is_dir(),
    reason="project Node or frontend dependencies missing; run ./frontend.sh prepare",
)
def test_wire_conformance_w01_to_w26(harness_factory):
    harness = harness_factory(chunk_delay_s=0.002)
    env = {
        "PATH": f"{NODE.parent}:/usr/bin:/bin",
        "HOME": os.environ.get("HOME", "/tmp"),
        "APORISA_BASE_URL": f"{harness.server.base}/v1",
        "APORISA_API_KEY": API_KEY,
        "APORISA_MODEL": ALIAS,
    }
    result = subprocess.run(
        [str(NODE), "tools/conformance.ts"],
        cwd=FRONTEND,
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
    )
    lines = [line for line in result.stdout.splitlines() if " W" in line]
    failed = [line for line in lines if " fail " in line]
    assert result.returncode == 0 and not failed, (
        "\n".join(failed) or result.stdout[-2000:] + result.stderr[-2000:]
    )
    assert len(lines) == 26
