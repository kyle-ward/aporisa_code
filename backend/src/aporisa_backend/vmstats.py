"""System-wide virtual-memory counters (macOS), for measuring memory pressure.

The same numbers `vm_stat` and `sysctl vm.swapusage` print, read through host_statistics64
and sysctlbyname so they are cheap enough to sample per request and every second.
Counters are cumulative since boot; callers report deltas.
"""

from __future__ import annotations

import ctypes
import resource

HOST_VM_INFO64 = 4
PAGE = 16384


class _VMStatistics64(ctypes.Structure):
    _fields_ = [
        ("free_count", ctypes.c_uint32),
        ("active_count", ctypes.c_uint32),
        ("inactive_count", ctypes.c_uint32),
        ("wire_count", ctypes.c_uint32),
        ("zero_fill_count", ctypes.c_uint64),
        ("reactivations", ctypes.c_uint64),
        ("pageins", ctypes.c_uint64),
        ("pageouts", ctypes.c_uint64),
        ("faults", ctypes.c_uint64),
        ("cow_faults", ctypes.c_uint64),
        ("lookups", ctypes.c_uint64),
        ("hits", ctypes.c_uint64),
        ("purges", ctypes.c_uint64),
        ("purgeable_count", ctypes.c_uint32),
        ("speculative_count", ctypes.c_uint32),
        ("decompressions", ctypes.c_uint64),
        ("compressions", ctypes.c_uint64),
        ("swapins", ctypes.c_uint64),
        ("swapouts", ctypes.c_uint64),
        ("compressor_page_count", ctypes.c_uint32),
        ("throttled_count", ctypes.c_uint32),
        ("external_page_count", ctypes.c_uint32),
        ("internal_page_count", ctypes.c_uint32),
        ("total_uncompressed_pages_in_compressor", ctypes.c_uint64),
    ]


class _SwapUsage(ctypes.Structure):
    _fields_ = [
        ("total", ctypes.c_uint64),
        ("avail", ctypes.c_uint64),
        ("used", ctypes.c_uint64),
        ("pagesize", ctypes.c_uint32),
        ("encrypted", ctypes.c_int32),
    ]


_libc = ctypes.CDLL(None)
_libc.mach_host_self.restype = ctypes.c_uint32
_libc.host_statistics64.argtypes = [
    ctypes.c_uint32,
    ctypes.c_int,
    ctypes.c_void_p,
    ctypes.POINTER(ctypes.c_uint32),
]
_libc.sysctlbyname.argtypes = [
    ctypes.c_char_p,
    ctypes.c_void_p,
    ctypes.POINTER(ctypes.c_size_t),
    ctypes.c_void_p,
    ctypes.c_size_t,
]
_HOST = _libc.mach_host_self()

# Counters reported as per-request deltas (pages, except swap_used_bytes).
COUNTERS = ("pageins", "pageouts", "compressions", "decompressions", "swapins", "swapouts")


def sample() -> dict:
    """Current counters: cumulative events plus instantaneous compressor and swap usage."""
    stats = _VMStatistics64()
    count = ctypes.c_uint32(ctypes.sizeof(stats) // 4)
    if _libc.host_statistics64(_HOST, HOST_VM_INFO64, ctypes.byref(stats), ctypes.byref(count)):
        raise OSError("host_statistics64 failed")
    swap = _SwapUsage()
    size = ctypes.c_size_t(ctypes.sizeof(swap))
    if _libc.sysctlbyname(b"vm.swapusage", ctypes.byref(swap), ctypes.byref(size), None, 0):
        raise OSError("sysctlbyname vm.swapusage failed")
    result = {name: int(getattr(stats, name)) for name in COUNTERS}
    result.update(
        free_bytes=stats.free_count * PAGE,
        wired_bytes=stats.wire_count * PAGE,
        compressor_bytes=stats.compressor_page_count * PAGE,
        swap_used_bytes=int(swap.used),
        major_faults=resource.getrusage(resource.RUSAGE_SELF).ru_majflt,
    )
    return result


def delta(before: dict, after: dict) -> dict:
    """Per-interval pressure: event counts, swap growth, this process's major faults."""
    result = {f"sys_{name}": after[name] - before[name] for name in COUNTERS}
    result["swap_growth_bytes"] = after["swap_used_bytes"] - before["swap_used_bytes"]
    result["major_faults"] = after["major_faults"] - before["major_faults"]
    result["compressor_bytes"] = after["compressor_bytes"]
    return result
