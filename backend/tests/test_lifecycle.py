"""Lifecycle checks, receipts and entry scripts (no network, no sudo, no launchd changes)."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from aporisa_backend.configs.models import active_pointer
from aporisa_backend.lifecycle import artifacts, assets, checks
from aporisa_backend.lifecycle.assets import Layout
from aporisa_backend.lifecycle.report import Report

ROOT = Path(__file__).resolve().parents[2]
REVISION = "a" * 40


def test_configuration_check(tmp_path):
    (tmp_path / "backend").mkdir()
    report = Report()
    assert checks.configuration_check(tmp_path, report) is None
    assert report.codes("MANUAL") == {"configuration"}
    (tmp_path / "backend" / ".env").write_text(
        "APORISA_API_KEY=k-123\nAPORISA_BACKEND_PORT=18123\n"
    )
    report = Report()
    settings = checks.configuration_check(tmp_path, report)
    assert settings.port == 18123 and report.ready
    (tmp_path / "backend" / ".env").write_text("APORISA_API_KEY=k\nAPORISA_MODEL=x\n")
    assert checks.configuration_check(tmp_path, Report()) is None


def test_source_receipt_goes_stale(tmp_path):
    source = tmp_path / "backend" / "src" / "pkg.py"
    source.parent.mkdir(parents=True)
    source.write_text("a = 1\n")
    with pytest.raises(ValueError, match="missing"):
        artifacts.verify_source_receipt(tmp_path)
    artifacts.write_source_receipt(tmp_path)
    artifacts.verify_source_receipt(tmp_path)
    source.write_text("a = 2\n")
    with pytest.raises(ValueError, match="stale"):
        artifacts.verify_source_receipt(tmp_path)


@pytest.fixture
def served(tmp_path):
    """The pointed identity registered in a temporary layout (a small stand-in directory)."""
    _, identity = active_pointer()
    layout = Layout(tmp_path)
    version = "d" * 16
    directory = layout.models / "Served" / version
    directory.mkdir(parents=True)
    (directory / "config.json").write_text("{}")
    (directory / "model.safetensors").write_bytes(b"\x00" * 128)
    record = {
        "schema": 1,
        "identity": identity,
        "directory": "Served",
        "version": version,
        "state": "ready",
        "source": {
            "kind": "convert",
            "recipe": "affine4g64",
            "recipe_digest": "d" * 64,
            "spec": {},
            "tools": {},
            "from": {"identity": "Up", "repository": "Owner/Model", "revision": REVISION},
        },
        "files": assets.inventory(directory),
    }
    assets.atomic_json(layout.record("Served"), record)
    return layout, directory


def test_model_check_receipt_and_wired_limit(served, monkeypatch):
    layout, directory = served
    monkeypatch.setattr(checks, "wired_limit_mb", lambda: 87040)
    report = Report()
    assert checks.model_check(layout.root, report, full=False) is None
    assert report.codes("REPAIRABLE") == {"assets"}  # prepare has not verified it yet

    report = Report()
    selection = checks.model_check(layout.root, report, full=True)
    assert selection is not None and report.ready
    artifacts.write_assets_receipt(layout, selection)
    report = Report()
    assert checks.model_check(layout.root, report, full=False) is not None and report.ready

    (directory / "config.json").write_text("[]")
    report = Report()
    assert checks.model_check(layout.root, report, full=False) is None
    assert report.codes("MANUAL") == {"assets"}

    monkeypatch.setattr(checks, "wired_limit_mb", lambda: 65536)
    report = Report()
    checks.model_check(layout.root, report, full=False)
    assert "wired_limit" in report.codes("MANUAL")


def test_model_check_without_weights(tmp_path, monkeypatch):
    monkeypatch.setattr(checks, "wired_limit_mb", lambda: 87040)
    report = Report()
    assert checks.model_check(tmp_path, report, full=False) is None
    assert report.codes("MANUAL") == {"model"}


def test_report_classification():
    report = Report()
    report.add("a", "READY", "ok")
    assert report.ready and not report.blockers
    report.add("b", "REPAIRABLE", "prepare")
    assert not report.ready and not report.blockers
    report.add("c", "WAIT", "busy")
    assert report.blockers


def test_service_label_is_per_user_and_checkout():
    from aporisa_backend.lifecycle.service_guard import service_label

    label = service_label(ROOT)
    assert label.startswith("com.aporisa.backend.") and len(label.rsplit(".", 1)[1]) == 12


def run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=60)


def test_entry_scripts_help_and_argument_errors():
    usage = run("./backend_service.sh", "help")
    assert usage.returncode == 0 and "prepare" in usage.stdout and "uninstall" in usage.stdout
    assert run("./backend_service.sh", "bogus").returncode == 2
    assert run("./backend_service.sh", "status", "extra").returncode == 2
    weights = run("./model_weights.sh", "--help")
    assert weights.returncode == 0 and "convert" in weights.stdout
    assert run("./model_weights.sh", "delete", "../x").returncode == 1
    lifecycle = run("./scripts/backend.sh", "help")
    assert lifecycle.returncode == 0 and "backend_service.sh" in lifecycle.stdout


def test_service_template_is_valid():
    result = run("/usr/bin/plutil", "-lint", "deploy/templates/macos/backend.plist")
    assert result.returncode == 0


def test_open_files_limit_is_raised_from_launchd_default():
    """A process started with launchd's 256 descriptors raises its own soft limit."""
    import sys

    code = (
        "import resource\n"
        "hard = resource.getrlimit(resource.RLIMIT_NOFILE)[1]\n"
        "resource.setrlimit(resource.RLIMIT_NOFILE, (256, hard))\n"
        "from aporisa_backend.process_limits import raise_open_files\n"
        "print(raise_open_files(65536))\n"
    )
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert result.returncode == 0 and int(result.stdout) >= 65536


def test_page_cache_release_and_hashing_leave_no_cache(tmp_path):
    from aporisa_backend import pagecache

    path = tmp_path / "weights.safetensors"
    path.write_bytes(b"\x07" * (32 * 1024**2))
    path.read_bytes()
    assert pagecache.resident_bytes(path) > 0
    pagecache.release(path)
    assert pagecache.resident_bytes(path) == 0
    assets.sha256(path)  # verifying a weight file releases what it read
    assert pagecache.resident_bytes(path) == 0
    pagecache.release_all([tmp_path / "missing", path])  # best effort, never raises


def test_vm_counters_and_deltas():
    from aporisa_backend import vmstats

    before = vmstats.sample()
    after = vmstats.sample()
    assert after["compressions"] >= before["compressions"] and after["swap_used_bytes"] >= 0
    delta = vmstats.delta(before, after)
    assert set(delta) >= {"sys_swapouts", "sys_compressions", "swap_growth_bytes", "major_faults"}
