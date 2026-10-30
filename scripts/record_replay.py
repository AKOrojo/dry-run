"""Record a live agent session from the deployed API as a labelled demo-day fallback (provider "replay").

  DRYRUN_TEAM_TOKEN=... python scripts/record_replay.py --provider meta --aoi lagos-lekki-v2 --question "..."

Writes dryrun/presets/replays/<slug>.json. Only sessions that end in a brief with every claim verified are kept:
a fallback that shows a failure is no fallback.
"""
import argparse
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="https://dryrun-vcdpde6nnq-uc.a.run.app")
ap.add_argument("--provider", default="meta")
ap.add_argument("--aoi", required=True)
ap.add_argument("--question", required=True)
args = ap.parse_args()

events, t0 = [], time.time()
with httpx.stream("POST", f"{args.base}/api/agent", timeout=330,
                  json={"question": args.question, "provider": args.provider, "aoi_id": args.aoi},
                  headers={"X-Team-Token": os.environ["DRYRUN_TEAM_TOKEN"]}) as r:
    r.raise_for_status()
    for line in r.iter_lines():
        if line.startswith("data: "):
            events.append({"t": round(time.time() - t0, 2), **json.loads(line[6:])})

brief = next((e["data"] for e in events if e["kind"] == "brief"), None)
errors = [e for e in events if e["kind"] == "error"]
if not brief or errors or not all(c["verified"] for c in brief["claims"]):
    raise SystemExit(f"not recorded: brief={bool(brief)} errors={len(errors)} "
                     f"verified={sum(c['verified'] for c in brief['claims']) if brief else 0} "
                     f"first error={json.dumps(errors[0]['data'])[:300] if errors else None}")
slug = f"{args.aoi}-{re.sub(r'[^a-z0-9]+', '-', args.question.lower()).strip('-')[:48]}"
out = Path(__file__).resolve().parents[1] / "dryrun/presets/replays" / f"{slug}.json"
out.write_text(json.dumps({
    "recorded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "base": args.base,
    "provider": brief["provider"], "model": brief["model"], "aoi_id": args.aoi, "question": args.question,
    "events": events}, indent=1, ensure_ascii=False) + "\n")
print(f"{out.name}: {len(events)} events, {events[-1]['t']}s, {len(brief['claims'])}/{len(brief['claims'])} verified")
