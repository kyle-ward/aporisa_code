"""Deployment settings: the only values read from backend/.env (AGENTS.md).

.env holds deployment differences only: the API key and every port the backend listens on.
The backend listens on exactly one port; the worker talks over an inherited socketpair.
Everything else is reviewed policy in the sibling configs modules.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
ENV_FILE = ROOT / "backend" / ".env"
HOST = "127.0.0.1"
DEFAULT_PORT = 18080
ALLOWED_ENV = ("APORISA_API_KEY", "APORISA_BACKEND_PORT")
PLACEHOLDER_KEY = "REPLACE_WITH_A_RANDOM_SECRET"


def read_environment(env_file: Path = ENV_FILE) -> dict[str, str | None]:
    """Process environment wins over .env; unknown .env keys are an error."""
    from dotenv import dotenv_values

    values = dotenv_values(env_file, interpolate=False) if env_file.is_file() else {}
    unknown = set(values) - set(ALLOWED_ENV)
    if unknown:
        raise ValueError("backend/.env supports only APORISA_API_KEY and APORISA_BACKEND_PORT")
    return {name: os.environ.get(name, values.get(name)) for name in ALLOWED_ENV}


def parse_port(raw: str | None) -> int:
    if raw is None:
        return DEFAULT_PORT
    if not raw.isdigit() or not 1 <= int(raw) <= 65535:
        raise ValueError("APORISA_BACKEND_PORT must be a decimal integer from 1 to 65535")
    return int(raw)


def valid_key(key: str | None) -> bool:
    return bool(key) and key != PLACEHOLDER_KEY and all(33 <= ord(c) <= 126 for c in key)


@dataclass(frozen=True)
class Settings:
    root: Path
    api_key: str = field(repr=False)
    port: int = DEFAULT_PORT
    host: str = HOST

    @classmethod
    def read(
        cls, *, env_file: Path = ENV_FILE, root: Path = ROOT, require_key: bool = True
    ) -> Settings:
        values = read_environment(env_file)
        key = values["APORISA_API_KEY"] or ""
        if require_key and not valid_key(key):
            raise ValueError(
                "APORISA_API_KEY must be a non-empty, non-placeholder printable ASCII secret"
            )
        return cls(root=root, api_key=key, port=parse_port(values["APORISA_BACKEND_PORT"]))
