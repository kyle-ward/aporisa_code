"""Per-process resource limits the backend sets for itself.

launchd starts daemons with a soft limit of 256 open files, but the external PLE table alone
maps 128 shards x 3 tensors (numpy keeps one descriptor per memmap), so the worker needs more.
Raising the soft limit up to the hard limit needs no privilege and changes nothing
system-wide.
"""

from __future__ import annotations

import resource


def raise_open_files(target: int) -> int:
    """Raises RLIMIT_NOFILE's soft limit to `target` (never lowers it); returns the result."""
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    if soft != resource.RLIM_INFINITY and soft < target:
        wanted = target if hard == resource.RLIM_INFINITY else min(target, hard)
        try:
            resource.setrlimit(resource.RLIMIT_NOFILE, (wanted, hard))
        except (ValueError, OSError):
            pass  # keep the inherited limit; startup reports the failure if it matters
    return resource.getrlimit(resource.RLIMIT_NOFILE)[0]
