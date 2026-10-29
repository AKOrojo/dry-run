"""LLM providers behind ONE OpenAI-compatible interface (owner: Eng C).

  meta     -> Meta Model API, Muse Spark 1.3            (standard mode: user uploads)
  baseten  -> Muse Spark Open, "sovereign mode"         ($10K open-weights bonus)
  openrouter -> Muse Spark Open via OpenRouter          (sovereign mode until Baseten -1026 is live)
  fake     -> scripted, no network; used by tests and by Eng B before keys exist

Day-1 TODO (Eng C): confirm base URLs, model ids and tool-call/JSON-schema
support in dev.meta.ai + Baseten docs; update DEFAULTS below. The hackathon guide
says to use `meta-models/muse-spark-open-1026` on Baseten (NOT the docs' id).
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass

log = logging.getLogger("dryrun.llm")

DEFAULTS = {
    "meta": {
        "base_url": os.getenv("META_BASE_URL", "https://api.meta.ai/v1"),
        "model": os.getenv("META_AGENT_MODEL", "muse-spark-1.3"),
        "key_env": "META_API_KEY",
    },
    "baseten": {
        "base_url": os.getenv("BASETEN_BASE_URL", "https://inference.baseten.co/v1"),
        "model": os.getenv("BASETEN_MODEL", "meta-models/muse-spark-open-1026"),
        "key_env": "BASETEN_API_KEY",
    },
    # Sovereign mode (lead's decision) while Baseten -1026 access is pending. Not a listed hackathon inference
    # partner, so this traffic may not count for the open-weights prize; Baseten remains the prize route.
    "openrouter": {
        "base_url": os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
        "model": os.getenv("OPENROUTER_MODEL", "meta/muse-spark-open"),
        "key_env": "OPENROUTER_API_KEY",
    },
}


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str


@dataclass
class Turn:
    content: str | None
    tool_calls: list[ToolCall]
    raw: dict


class OpenAICompatProvider:
    def __init__(self, name: str):
        cfg = DEFAULTS[name]
        self.name, self.model, self.base_url = name, cfg["model"], cfg["base_url"]
        self.key = os.environ.get(cfg["key_env"], "").strip()
        if self.key in ("", "unset"):  # bootstrap seeds secrets with the placeholder "unset"
            raise RuntimeError(f"{cfg['key_env']} is not set for provider '{name}'")

    def chat(self, messages: list[dict], tools: list[dict] | None = None,
             response_format: dict | None = None, max_tokens: int = 4000) -> Turn:
        import httpx

        body = {"model": self.model, "messages": messages, "max_tokens": max_tokens}
        if tools:
            body["tools"] = tools
        if response_format:
            body["response_format"] = response_format
        r = httpx.post(f"{self.base_url}/chat/completions", json=body, timeout=60,
                       headers={"Authorization": f"Bearer {self.key}"})
        r.raise_for_status()
        data = r.json()
        # Proof-of-use log (open-weights prize is verified by the partner): one line per call.
        log.info("llm_call provider=%s model=%s response_id=%s usage=%s",
                 self.name, self.model, data.get("id"), json.dumps(data.get("usage")))
        msg = data["choices"][0]["message"]
        calls = [ToolCall(c["id"], c["function"]["name"], c["function"]["arguments"])
                 for c in (msg.get("tool_calls") or [])]
        return Turn(msg.get("content"), calls, data)


class FakeProvider:
    """Deterministic script: baseline run -> drain upgrade run -> compare -> brief."""

    name, model = "fake", "fake-scripted"

    def __init__(self):
        self.step = 0

    def chat(self, messages, tools=None, response_format=None, max_tokens=4000) -> Turn:
        self.step += 1
        results = [json.loads(m["content"]) for m in messages if m["role"] == "tool"]
        aoi = os.getenv("DRYRUN_DEFAULT_AOI", "fixture-synthetic")
        storm = {"total_mm": 120, "duration_h": 3}
        last = messages[-1]["content"] if messages[-1]["role"] == "user" else ""
        if "Write the decision brief" in last or "That was not valid" in last:  # brief request or retry
            base, alt = results[1]["run_id"], results[2]["run_id"]
            d = results[3]["delta"]
            return Turn(json.dumps({
                "title": "Drain upgrade vs. baseline (fake agent)",
                "summary": "Tripling drain capacity reduces impassable roads in this storm.",
                "claims": [
                    {"text": "Change in impassable road length", "model_value": d["road_km_impassable"],
                     "unit": "km", "source_run_id": alt, "field": f"delta:road_km_impassable:{base}"},
                    {"text": "Buildings flooded with upgrade", "model_value": None,
                     "unit": "buildings", "source_run_id": alt, "field": "buildings_flooded"},
                ],
                "recommended_run_id": alt,
            }), [], {})
        script = [
            ("get_aoi_info", {"aoi_id": aoi}),
            ("run_simulation", {"aoi_id": aoi, "storm": storm, "label": "baseline"}),
            ("run_simulation", {"aoi_id": aoi, "storm": storm, "label": "drains x3",
                                "interventions": [{"type": "drain_upgrade", "capacity_factor": 3.0}]}),
        ]
        if self.step <= 3:
            n, a = script[self.step - 1]
            return Turn(None, [ToolCall(f"c{self.step}", n, json.dumps(a))], {})
        if self.step == 4:
            return Turn(None, [ToolCall("c4", "compare_runs", json.dumps(
                {"base_run_id": results[1]["run_id"], "alt_run_id": results[2]["run_id"]}))], {})
        return Turn("Done comparing.", [], {})


def get_provider(name: str):
    return FakeProvider() if name == "fake" else OpenAICompatProvider(name)
