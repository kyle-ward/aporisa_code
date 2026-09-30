"""A compact Python version of the protocol's stream ordering rules (section 7.3), for tests."""

from __future__ import annotations

TERMINAL = {"response.completed", "response.incomplete", "response.failed"}


def check_stream(events: list[dict], *, prewarm: bool = False) -> dict:
    """Asserts the ordering rules and returns the terminal response."""
    assert events, "empty stream"
    assert [e["sequence_number"] for e in events] == list(range(len(events))), "sequence gap"
    assert events[0]["type"] == "response.created"
    assert (
        events[0]["response"]["status"] == "in_progress" and events[0]["response"]["output"] == []
    )
    assert events[-1]["type"] in TERMINAL, "missing terminal event"
    assert sum(e["type"] in TERMINAL for e in events) == 1, "more than one terminal event"
    done: list[dict] = []
    current = None
    for event in events[1:-1]:
        kind = event["type"]
        if kind == "response.output_item.added":
            assert current is None, "items interleave"
            assert event["output_index"] == len(done)
            current = {"item": event["item"], "text": ""}
        elif kind == "response.output_item.done":
            assert current is not None and event["item"]["id"] == current["item"]["id"]
            item = event["item"]
            if item["type"] in ("message", "reasoning"):
                assert item["content"][0]["text"] == current["text"], "deltas differ from done text"
            if item["type"] == "function_call":
                assert item["arguments"] == current["text"]
                assert item["call_id"] == current["item"]["call_id"]
            done.append(item)
            current = None
        elif kind.endswith(".delta"):
            assert current is not None and event["item_id"] == current["item"]["id"]
            current["text"] += event["delta"]
        else:
            assert current is not None, f"{kind} outside an item"
    response = events[-1]["response"]
    assert response["output"] == done, "terminal output differs from done items"
    if response["status"] in ("completed", "incomplete"):
        usage = response["usage"]
        assert usage["total_tokens"] == usage["input_tokens"] + usage["output_tokens"]
    if prewarm:
        assert len(events) == 2 and response["usage"]["output_tokens"] == 0
    return response
