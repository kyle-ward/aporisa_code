"""Page-cache residency and release for large read-only files (macOS).

Reading ~100 GiB of weights (full SHA256 in prepare, the model load) leaves those file pages
cached. On a 96 GiB machine with ~70 GiB taken by the model, the kernel then compresses and
swaps other programs' memory instead, which the desktop feels as stutter. `release` drops a
file's clean cached pages (msync MS_INVALIDATE on a shared read-only mapping); F_NOCACHE
reads were measured to still leave most pages cached, so they are not used.

Only for files nobody writes: the cached pages are clean, so releasing them never loses data;
a process still mapping the file simply faults the pages back in when it reads them.
"""

from __future__ import annotations

import ctypes
import os
from pathlib import Path

PAGE = os.sysconf("SC_PAGE_SIZE")
PROT_READ, MAP_SHARED, MS_INVALIDATE = 0x1, 0x1, 0x2
MAP_FAILED = ctypes.c_void_p(-1).value

_libc = ctypes.CDLL(None, use_errno=True)
_libc.mmap.restype = ctypes.c_void_p
_libc.mmap.argtypes = [
    ctypes.c_void_p,
    ctypes.c_size_t,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_longlong,
]
_libc.munmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
_libc.msync.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int]
_libc.mincore.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_char_p]


def _with_mapping(path: Path, action):
    size = path.stat().st_size
    if size == 0:
        return None
    fd = os.open(path, os.O_RDONLY)
    try:
        address = _libc.mmap(None, size, PROT_READ, MAP_SHARED, fd, 0)
        if address in (None, MAP_FAILED):
            raise OSError(ctypes.get_errno(), "mmap failed")
        try:
            return action(address, size)
        finally:
            _libc.munmap(address, size)
    finally:
        os.close(fd)


def resident_bytes(path: Path) -> int:
    """Bytes of `path` currently in the page cache (mincore)."""
    import numpy as np

    def count(address: int, size: int) -> int:
        vector = ctypes.create_string_buffer((size + PAGE - 1) // PAGE)
        if _libc.mincore(address, size, vector) != 0:
            raise OSError(ctypes.get_errno(), "mincore failed")
        return int((np.frombuffer(vector.raw, dtype=np.uint8) & 1).sum()) * PAGE

    return _with_mapping(path, count) or 0


def release(path: Path) -> None:
    """Drops the clean cached pages of a read-only file."""

    def invalidate(address: int, size: int) -> None:
        if _libc.msync(address, size, MS_INVALIDATE) != 0:
            raise OSError(ctypes.get_errno(), "msync failed")

    _with_mapping(path, invalidate)


def release_all(paths) -> None:
    """Best effort: a file that cannot be released keeps its cache, nothing else changes."""
    for path in paths:
        try:
            release(Path(path))
        except OSError:
            pass
