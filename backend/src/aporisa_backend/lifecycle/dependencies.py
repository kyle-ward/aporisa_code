"""Installed packages versus backend/uv.lock, without importing the inference framework."""

from __future__ import annotations

import importlib.metadata
import sys
import tomllib
from pathlib import Path

PROJECT = "aporisa-backend"


def verify_dependencies(root: Path, *, dev: bool = True) -> int:
    """Raises ValueError unless the project venv holds exactly the locked distributions."""
    from packaging.markers import Marker
    from packaging.utils import canonicalize_name

    if sys.version_info[:2] != (3, 12):
        raise ValueError("Python 3.12 is required")
    if Path(sys.prefix).resolve() != (root / "backend" / ".venv").resolve():
        raise ValueError("The project Python is required")
    lock = tomllib.loads((root / "backend" / "uv.lock").read_text())
    packages = {canonicalize_name(p["name"]): p for p in lock["package"]}
    app = packages[PROJECT]
    pending = [{"name": PROJECT}]
    if dev:
        pending += app.get("dev-dependencies", {}).get("dev", [])
    checked: set[str] = set()
    while pending:
        edge = pending.pop()
        if edge.get("marker") and not Marker(edge["marker"]).evaluate():
            continue
        name = canonicalize_name(edge["name"])
        if name in checked:
            continue
        checked.add(name)
        package = packages[name]
        installed = importlib.metadata.distribution(name)
        if installed.version != package["version"]:
            raise ValueError("Installed dependency does not match the lock")
        files = installed.files
        if not files:
            raise ValueError("Installed dependency inventory missing")
        for file in files:
            if file.suffix != ".pyc" and not installed.locate_file(file).is_file():
                raise ValueError("Installed dependency file missing")
        pending.extend(package.get("dependencies", []))
    return len(checked)


def main() -> None:
    """Fixed-output probe run with the project Python (never loads weights)."""
    root = Path(__file__).resolve().parents[4]
    try:
        verify_dependencies(root)
    except Exception:  # noqa: BLE001 - fixed output only
        print("dependencies_unprepared")
        raise SystemExit(1) from None
    print("dependencies_ready")


if __name__ == "__main__":
    main()
