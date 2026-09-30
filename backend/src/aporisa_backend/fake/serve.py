"""Serves the real gateway with the fake worker, for running the wire conformance suite.

    backend/.venv/bin/python -m aporisa_backend.fake.serve --port 18099 --api-key test-key

Development and test tool only: no model, no lifecycle, loopback only.
"""

from __future__ import annotations

import argparse

import uvicorn

from ..configs.limits import LIMITS
from ..configs.models import PROFILES, active_pointer
from ..gateway.app import create_app
from ..gateway.runtime import Runtime
from .worker import FakeWorker


def build(api_key: str, *, chunk_delay_s: float = 0.002):
    alias, identity = active_pointer()
    profile = PROFILES[identity]
    runtime = Runtime(
        alias,
        profile,
        lambda: FakeWorker(profile, alias, chunk_size=4, chunk_delay_s=chunk_delay_s),
    )
    return create_app(runtime, api_key, LIMITS)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--api-key", required=True)
    args = parser.parse_args()
    uvicorn.run(
        build(args.api_key),
        host="127.0.0.1",
        port=args.port,
        ws="websockets-sansio",
        lifespan="on",
        log_level="warning",
        access_log=False,
        server_header=False,
    )


if __name__ == "__main__":
    main()
