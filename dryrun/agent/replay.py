"""Labelled demo-day fallback: stream a recorded live session (scripts/record_replay.py) instead of calling
a model. Free and ungated: it replays stored events and never calls a provider or the solver."""

import json
import time
from collections.abc import Callable, Iterator
from functools import lru_cache
from importlib.resources import files

from dryrun.contracts import AgentEvent

MAX_GAP_S = 3.0  # long solver waits are shortened; the opening label says so


@lru_cache(maxsize=1)
def recordings() -> list[dict]:
    d = files("dryrun.presets").joinpath("replays")
    if not d.is_dir():
        return []
    return [json.loads(p.read_text()) for p in sorted(d.iterdir(), key=lambda p: p.name) if p.name.endswith(".json")]


def _fold(q: str) -> str:
    return " ".join(q.split()).casefold()


def find(question: str) -> dict | None:
    return next((r for r in recordings() if _fold(r["question"]) == _fold(question)), None)


def stream(rec: dict, sleep: Callable[[float], None] | None = None) -> Iterator[AgentEvent]:
    sleep = sleep or time.sleep
    yield AgentEvent(kind="thought", data={"replay": True, "text": (
        f"REPLAY of a recorded live session ({rec['model']} via {rec['provider']}, recorded {rec['recorded_at']}). "
        "This is not a live model call; long waits are shortened.")})
    prev = 0.0
    for e in rec["events"]:
        sleep(max(0.0, min(e["t"] - prev, MAX_GAP_S)))
        prev = e["t"]
        yield AgentEvent(kind=e["kind"], data=e["data"])
