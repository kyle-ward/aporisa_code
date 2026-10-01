#!/usr/bin/env python3
"""Long-running soak against the running backend (DEVELOPMENT_PLAN B2-7): leaks, slowdowns,
stability over hours.

    backend/.venv/bin/python scripts/soak.py [--hours 4] [--cycle-minutes 30] [--threads 3]
        [--long-tokens 131072] [--final-long 200000] [--restart-pause] [--idle-hours 8]

Run explicitly by the user against a started service, never part of scripts/check.sh; it
keeps memory under pressure for hours, so run it when the machine is not needed. Results
(numbers only, never text) go to .runtime/validation/soak_<time>.jsonl.

Each cycle (--cycle-minutes) runs, in turn:

  probe    a 5-turn agent loop on a fresh key and one fixed answer: first-token median and
           decode speed, compared between the first and the last cycle
  agents   --threads coding-agent sessions (pinned repository files, as --agent-loop in
           validate_runtime.py) advanced round-robin; a thread past --reset-tokens starts
           over, as after a compaction; budget evictions, SSD spills and restores follow
  long     one cold prefill of --long-tokens on its own key (0: none)
  misc     images (the same twice, then another), text.format, a WebSocket continuation,
           a prewarm, a token count
  faults   a client gone mid-stream, a burst of parallel requests (queueing, 429), an
           invalid image (400)

Every 10 seconds it samples /health/runtime (worker memory, sessions, SSD cache, restarts,
resident size, open descriptors) and the system (free, compressor, swap, pressure).
Options: --restart-pause stops halfway and asks the user to run ./backend_service.sh
restart (the graceful stop writes the sessions; an agent thread must come back from SSD);
--final-long builds one more long context at the end; --idle-hours keeps sampling with no
requests, then probes again (whether the idle worker stays resident and fast).

Pass criteria (summary line, exit 1 on a failure):
  leak       each cycle's lowest worker memory not held by weights or sessions, and its
             lowest resident size, grow by at most 0.5 GB / 1 GB from the first cycle;
             open descriptors by at most 16
  decay      the last probe's first-token median and decode speed within 5% of the first
  stable     no failed response other than the deliberate faults, no worker restart
  memory     swap grows by at most 256 MiB; the SSD cache stays within its cap
  privacy    the run's marker never appears in the service's log files
"""

from __future__ import annotations

import argparse
import asyncio
import json
import secrets
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import validate_runtime as vr  # noqa: E402

httpx, websockets, vmstats, emit = vr.httpx, vr.websockets, vr.vmstats, vr.emit

GB = 1000**3
LEAK_MEMORY_BYTES = int(0.5 * GB)
LEAK_RSS_BYTES = 1 * GB
LEAK_FDS = 16
DECAY_ALLOWED = 0.05
SWAP_ALLOWED = 256 * 1024**2
SSD_CAP_BYTES = 64 * 1024**3
PROBE_QUESTION = "Explain in about 150 words how a hash map handles collisions."
SMALL_SCHEMA = {
    "type": "object",
    "properties": {"ok": {"type": "boolean"}, "word": {"type": "string"}},
    "required": ["ok", "word"],
}


class Soak:
    def __init__(self, validator: vr.Validator, args, marker: str):
        self.v, self.args, self.marker = validator, args, marker
        self.phase, self.cycle = "start", 0
        self.failures: list[str] = []
        self.probes: list[dict] = []
        self.samples: list[dict] = []
        self.threads = [self._thread(i) for i in range(args.threads)]
        self.file_turn = 0

    # --- requests ---------------------------------------------------------------------------

    def _thread(self, index: int) -> dict:
        key = f"soak-agent-{index}-{secrets.token_hex(4)}"
        first = vr.user(f"[{self.marker}] Map how sessions are cached, file by file.")
        return {"key": key, "history": [first], "turns": 0}

    async def stream(self, client, body: dict, what: str) -> dict | None:
        try:
            response, _ = await self.v.stream(client, body)
        except Exception as error:  # noqa: BLE001 - every failure is counted, none stops the run
            self.failures.append(f"{what}: {type(error).__name__}")
            return None
        if response["status"] == "failed":
            self.failures.append(f"{what}: {(response.get('error') or {}).get('code')}")
        return response

    async def last(self, client) -> dict:
        try:
            return ((await self.v.runtime(client)).get("worker") or {}).get("last") or {}
        except Exception:  # noqa: BLE001
            return {}

    def tool_turn(self, history: list[dict]) -> None:
        path = vr.AGENT_FILES[self.file_turn % len(vr.AGENT_FILES)]
        size = vr.AGENT_SIZES[self.file_turn % len(vr.AGENT_SIZES)]
        self.file_turn += 1
        call_id = f"call_{secrets.token_hex(4)}"
        history.append(
            {
                "type": "function_call",
                "call_id": call_id,
                "name": "read_file",
                "arguments": json.dumps({"path": path}),
            }
        )
        history.append(
            {"type": "function_call_output", "call_id": call_id, "output": vr._pinned(path)[:size]}
        )

    def agent_body(self, history: list[dict], key: str) -> dict:
        return self.v.request(
            list(history),
            instructions=vr.AGENT_INSTRUCTIONS,
            tools=vr.AGENT_TOOLS,
            reasoning={"effort": "none"},
            max_output_tokens=32,
            prompt_cache_key=key,
        )

    async def agent_step(self, client, thread: dict) -> None:
        self.tool_turn(thread["history"])
        thread["turns"] += 1
        response = await self.stream(
            client, self.agent_body(thread["history"], thread["key"]), "agent"
        )
        if response is None or response["status"] == "failed":
            return
        last = await self.last(client)
        self.v.record(
            "soak.agent",
            cycle=self.cycle,
            input_tokens=response["usage"]["input_tokens"],
            cached_tokens=response["usage"]["input_tokens_details"]["cached_tokens"],
            restore_path=last.get("restore_path"),
            first_token_ms=last.get("first_token_ms"),
        )
        if response["usage"]["input_tokens"] > self.args.reset_tokens:
            index = self.threads.index(thread)
            self.threads[index] = self._thread(index)  # as after a compaction

    async def probe(self, client, label: str) -> None:
        key = f"soak-probe-{secrets.token_hex(4)}"
        history = [vr.user(f"[{self.marker}] Summarize the session code, one file at a time.")]
        firsts = []
        for _ in range(5):
            self.tool_turn(history)
            response = await self.stream(client, self.agent_body(history, key), "probe")
            last = await self.last(client)
            if response is not None and last.get("first_token_ms"):
                firsts.append(last["first_token_ms"])
        body = self.v.request(
            [vr.user(PROBE_QUESTION)], reasoning={"effort": "none"}, max_output_tokens=256
        )
        response = await self.stream(client, body, "probe")
        last = await self.last(client)
        row = {
            "label": label,
            "cycle": self.cycle,
            "first_token_median_ms": statistics.median(firsts) if firsts else None,
            "decode_tok_s": last.get("decode_tok_s") if response is not None else None,
            "mtp_accept_rate": last.get("mtp_accept_rate"),
        }
        self.probes.append(row)
        self.v.record("soak.probe", **row)
        emit(
            "INFO",
            f"probe {label}: first token median {row['first_token_median_ms']} ms, decode "
            f"{row['decode_tok_s']} tok/s.",
        )

    async def long_context(self, client, tokens: int) -> None:
        key = f"soak-long-{secrets.token_hex(4)}"
        body, count, _ = await self.v.long_prompt(client, tokens, key)
        body = {**body, "max_output_tokens": 128}
        response = await self.stream(client, body, "long")
        last = await self.last(client)
        self.v.record(
            "soak.long",
            cycle=self.cycle,
            input_tokens=count,
            prefill_tok_s=last.get("prefill_tok_s"),
            decode_tok_s=last.get("decode_tok_s"),
            peak_memory_bytes=last.get("peak_memory_bytes"),
            completed=response is not None and response["status"] != "failed",
        )

    async def misc(self, client) -> None:
        picture = vr._picture("MANGO", (210, 30, 30))
        other = vr._picture("LEMON", (30, 30, 210))
        key = f"soak-misc-{secrets.token_hex(4)}"

        def asking(url: str) -> dict:
            content = [
                {"type": "input_text", "text": f"[{self.marker}] What word is shown?"},
                {"type": "input_image", "image_url": url},
            ]
            return self.v.request(
                [{"type": "message", "role": "user", "content": content}],
                reasoning={"effort": "none"},
                max_output_tokens=16,
                prompt_cache_key=key,
            )

        for url in (picture, picture, other):
            await self.stream(client, asking(url), "image")
        fmt = {"type": "json_schema", "name": "w", "schema": SMALL_SCHEMA, "strict": True}
        await self.stream(
            client,
            self.v.request(
                [vr.user("Answer with ok true and any word.")],
                reasoning={"effort": "none"},
                max_output_tokens=64,
                text={"format": fmt},
            ),
            "structured",
        )
        prewarm = self.v.request(
            [vr.user(f"[{self.marker}] Prewarm me.")],
            max_output_tokens=16,
            reasoning={"effort": "none"},
            prompt_cache_key=f"{key}-warm",
        )
        await self.stream(client, {**prewarm, "generate": False}, "prewarm")
        await self.stream(client, prewarm, "after prewarm")
        counted = await client.post(
            f"{self.v.base}/v1/responses/input_tokens", json=prewarm, headers=self.v.headers
        )
        if counted.status_code != 200:
            self.failures.append(f"count: HTTP {counted.status_code}")
        try:
            async with websockets.connect(self.v.ws_url, additional_headers=self.v.headers) as ws:

                async def create(body: dict) -> dict:
                    await ws.send(json.dumps({"type": "response.create", **body}))
                    while True:
                        event = json.loads(await ws.recv())
                        if event["type"] == "error" or event["type"] in vr.TERMINAL:
                            return event

                base = self.v.request(
                    [vr.user("Name one colour.")],
                    reasoning={"effort": "none"},
                    max_output_tokens=16,
                )
                first = await create(base)
                if first["type"] == "error":
                    self.failures.append("websocket: error")
                    return
                second = await create(
                    {
                        **base,
                        "input": [vr.user("Another.")],
                        "previous_response_id": first["response"]["id"],
                    }
                )
                if second["type"] == "error" or second["response"]["status"] == "failed":
                    self.failures.append("websocket: continuation")
        except Exception as error:  # noqa: BLE001
            self.failures.append(f"websocket: {type(error).__name__}")

    async def faults(self, client) -> None:
        # a client that leaves mid-stream: the cancel must free the admission slot
        body = self.v.request(
            [vr.user("Write a long story about a lighthouse keeper.")],
            reasoning={"effort": "none"},
            max_output_tokens=2000,
            tool_choice="none",
        )
        try:
            async with client.stream(
                "POST",
                f"{self.v.base}/v1/responses",
                json={**body, "stream": True},
                headers=self.v.headers,
            ) as response:
                async for line in response.aiter_lines():
                    if "output_text.delta" in line:
                        break
        except Exception as error:  # noqa: BLE001
            self.failures.append(f"disconnect: {type(error).__name__}")
        # a burst: one runs, two queue, the rest may get 429 queue_full (all are expected)
        burst = self.v.request(
            [vr.user("Say hi.")], reasoning={"effort": "none"}, max_output_tokens=8
        )

        async def one() -> int:
            async with client.stream(
                "POST",
                f"{self.v.base}/v1/responses",
                json={**burst, "stream": True},
                headers=self.v.headers,
            ) as response:
                await response.aread()
                return response.status_code

        statuses = await asyncio.gather(*(one() for _ in range(4)), return_exceptions=True)
        unexpected = [s for s in statuses if s not in (200, 429)]
        if unexpected:
            self.failures.append(f"burst: {unexpected}")
        # an invalid image: 400 before any stream
        broken = {"type": "input_image", "image_url": "data:image/png;base64,bm90IGFuIGltYWdl"}
        bad = self.v.request([{"type": "message", "role": "user", "content": [broken]}])
        reply = await client.post(
            f"{self.v.base}/v1/responses", json={**bad, "stream": True}, headers=self.v.headers
        )
        if reply.status_code != 400:
            self.failures.append(f"invalid image: HTTP {reply.status_code}")
        self.v.record("soak.faults", cycle=self.cycle, burst=[str(s) for s in statuses])

    # --- sampling ---------------------------------------------------------------------------

    async def sample_forever(self, client) -> None:
        while True:
            try:
                status = await self.v.runtime(client)
            except Exception:  # noqa: BLE001
                status = {}
            worker = status.get("worker") or {}
            system = vmstats.sample()
            active = worker.get("active_memory_bytes")
            weights = worker.get("weights_bytes")
            sessions = worker.get("session_bytes")
            row = {
                "phase": self.phase,
                "cycle": self.cycle,
                "t_s": round(time.monotonic() - self.v.started, 1),
                "state": status.get("state"),
                "restarts": status.get("restarts"),
                "sessions": worker.get("sessions"),
                "session_bytes": sessions,
                "unheld_bytes": active - weights - sessions
                if None not in (active, weights, sessions)
                else None,
                "rss_bytes": worker.get("rss_bytes"),
                "open_fds": worker.get("open_fds"),
                "ssd_cache_bytes": worker.get("ssd_cache_bytes"),
                "ssd_written_bytes": worker.get("ssd_written_bytes"),
                "free_bytes": system["free_bytes"],
                "compressor_bytes": system["compressor_bytes"],
                "swap_used_bytes": system["swap_used_bytes"],
                "pressure_level": system["pressure_level"],
            }
            self.samples.append(row)
            self.v.record("soak.sample", **row)
            await asyncio.sleep(10)

    # --- phases -----------------------------------------------------------------------------

    async def wait_ready(self, client, within_s: float = 900) -> None:
        deadline = time.monotonic() + within_s
        while time.monotonic() < deadline:
            try:
                if (await client.get(f"{self.v.base}/health/ready")).status_code == 200:
                    return
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(5)
        raise vr.Failure("the service did not become ready again")

    async def restart_pause(self, client) -> None:
        self.phase = "restart"
        emit("MANUAL", "Halfway: run ./backend_service.sh restart now, then press Enter here.")
        await asyncio.to_thread(input)
        await self.wait_ready(client)
        thread = self.threads[0]
        await self.agent_step(client, thread)
        last = await self.last(client)
        if last.get("restore_path") != "ssd":
            self.failures.append(f"after restart: restore path {last.get('restore_path')}")
        self.v.record("soak.restart", restore_path=last.get("restore_path"))

    async def active(self, client) -> None:
        args = self.args
        end = time.monotonic() + args.hours * 3600
        halfway = time.monotonic() + args.hours * 1800
        paused = not args.restart_pause
        while time.monotonic() < end:
            self.cycle += 1
            self.phase = "active"
            cycle_end = min(end, time.monotonic() + args.cycle_minutes * 60)
            emit("WAIT", f"Cycle {self.cycle}...")
            await self.probe(client, f"cycle {self.cycle}")
            if args.long_tokens:
                await self.long_context(client, args.long_tokens)
            await self.misc(client)
            await self.faults(client)
            while time.monotonic() < cycle_end:
                for thread in list(self.threads):
                    if time.monotonic() >= cycle_end:
                        break
                    await self.agent_step(client, thread)
            if not paused and time.monotonic() >= halfway:
                paused = True
                await self.restart_pause(client)
        if args.final_long:
            self.phase = "final_long"
            await self.long_context(client, args.final_long)
        self.phase = "end"
        await self.probe(client, "end")

    async def idle(self, client) -> None:
        self.phase = "idle"
        emit("WAIT", f"Idle for {self.args.idle_hours} h (sampling only)...")
        await asyncio.sleep(self.args.idle_hours * 3600)
        self.phase = "after_idle"
        await self.probe(client, "after idle")

    # --- verdict ----------------------------------------------------------------------------

    def summary(self, log_files: list[Path]) -> dict:
        def per_cycle(field: str, pick) -> dict[int, float]:
            values: dict[int, list] = {}
            for row in self.samples:
                if row["phase"] == "active" and row.get(field) is not None:
                    values.setdefault(row["cycle"], []).append(row[field])
            return {cycle: pick(v) for cycle, v in values.items()}

        def growth(field: str, pick=min) -> float | None:
            values = per_cycle(field, pick)
            if len(values) < 2:
                return None
            cycles = sorted(values)
            return values[cycles[-1]] - values[cycles[0]]

        result: dict = {
            "cycles": self.cycle,
            "unheld_growth_bytes": growth("unheld_bytes"),
            "rss_growth_bytes": growth("rss_bytes"),
            "open_fds_growth": growth("open_fds", max),
            "failures": len(self.failures),
        }
        first, last = (self.probes[0], self.probes[-1]) if self.probes else ({}, {})
        if first.get("first_token_median_ms") and last.get("first_token_median_ms"):
            result["first_token_ratio"] = round(
                last["first_token_median_ms"] / first["first_token_median_ms"], 3
            )
        if first.get("decode_tok_s") and last.get("decode_tok_s"):
            result["decode_ratio"] = round(last["decode_tok_s"] / first["decode_tok_s"], 3)
        swaps = [row["swap_used_bytes"] for row in self.samples]
        restarts = [row["restarts"] for row in self.samples if row["restarts"] is not None]
        ssd = [row["ssd_cache_bytes"] for row in self.samples if row["ssd_cache_bytes"]]
        written = [row["ssd_written_bytes"] for row in self.samples if row["ssd_written_bytes"]]
        result["swap_growth_bytes"] = (max(swaps) - swaps[0]) if swaps else 0
        result["worker_restarts"] = (max(restarts) - restarts[0]) if restarts else 0
        result["ssd_peak_bytes"] = max(ssd) if ssd else 0
        hours = max(self.args.hours, 1e-6)
        result["ssd_written_per_hour_bytes"] = (
            int((max(written) - min(written)) / hours) if written else 0
        )
        result["marker_in_logs"] = sum(
            path.read_text(errors="replace").count(self.marker) for path in log_files
        )
        checks = {
            "leak": (result["unheld_growth_bytes"] or 0) <= LEAK_MEMORY_BYTES
            and (result["rss_growth_bytes"] or 0) <= LEAK_RSS_BYTES
            and (result["open_fds_growth"] or 0) <= LEAK_FDS,
            "decay": result.get("first_token_ratio", 1) <= 1 + DECAY_ALLOWED
            and result.get("decode_ratio", 1) >= 1 - DECAY_ALLOWED,
            "stable": not self.failures and result["worker_restarts"] == 0,
            "memory": result["swap_growth_bytes"] <= SWAP_ALLOWED
            and result["ssd_peak_bytes"] <= SSD_CAP_BYTES,
            "privacy": result["marker_in_logs"] == 0,
        }
        result["checks"] = checks
        result["passed"] = all(checks.values())
        return result


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--hours", type=float, default=4.0, help="active load")
    parser.add_argument("--cycle-minutes", type=float, default=30.0)
    parser.add_argument("--threads", type=int, default=3, help="concurrent agent sessions")
    parser.add_argument("--reset-tokens", type=int, default=80_000, help="a thread starts over")
    parser.add_argument("--long-tokens", type=int, default=0, help="a long context per cycle")
    parser.add_argument("--final-long", type=int, default=0, help="a long context at the end")
    parser.add_argument("--restart-pause", action="store_true", help="ask for a restart halfway")
    parser.add_argument("--idle-hours", type=float, default=0.0, help="sampling with no load")
    parser.add_argument("--base-url", help="another server (default: backend/.env)")
    parser.add_argument("--api-key", help="its key")
    parser.add_argument("--no-log-scan", action="store_true", help="skip the log privacy scan")
    args = parser.parse_args()
    settings = vr.Settings.read()
    alias, _ = vr.active_pointer()
    stamp = time.strftime("%Y%m%d_%H%M%S")
    validator = vr.Validator(
        settings, alias, ROOT / ".runtime" / "validation" / f"soak_{stamp}.jsonl"
    )
    if args.base_url:
        validator.base = args.base_url.rstrip("/")
        validator.ws_url = validator.base.replace("http", "ws", 1) + "/v1/responses"
    if args.api_key:
        validator.headers = {"authorization": f"Bearer {args.api_key}"}
    marker = f"soak-marker-{secrets.token_hex(6)}"
    soak = Soak(validator, args, marker)
    started_wall = time.time()
    async with httpx.AsyncClient(timeout=vr.LONG_TIMEOUT_S, trust_env=False) as client:
        await validator.ready(client)
        sampler = asyncio.create_task(soak.sample_forever(client))
        try:
            await soak.active(client)
            if args.idle_hours:
                await soak.idle(client)
        finally:
            sampler.cancel()
    logs = (
        []
        if args.no_log_scan
        else [
            path
            for path in (ROOT / "backend" / "logs").glob("*.jsonl")
            if path.stat().st_mtime >= started_wall
        ]
    )
    result = soak.summary(logs)
    validator.record(
        "soak.summary", **{k: v for k, v in result.items() if k != "checks"}, **result["checks"]
    )
    for failure in soak.failures[:20]:
        emit("ERROR", f"failure: {failure}")
    verdict = ", ".join(
        f"{name} {'ok' if ok else 'FAILED'}" for name, ok in result["checks"].items()
    )
    emit("READY" if result["passed"] else "ERROR", f"Soak: {verdict}. Results: {validator.results}")
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
