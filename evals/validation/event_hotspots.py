"""Replay an observed rain sequence and score the press-reported flood places for that event (owner: Eng A).

hotspots.py scores a design storm; this drives the solver with the IMERG series for the event window (28 Jun -
4 Jul 2026 for Lekki: reports name flooded places on 30 Jun and 3 Jul) and scores the running maximum depth
against only the hotspots tagged with that event. IMERG underestimates intense short rain, so the replay is a
lower bound on depth; read the lift (concentration where people reported flooding), not the absolute hit rate.

  python evals/validation/event_hotspots.py --aoi lagos-lekki-v2 \\
      --series evals/validation/imerg_lagos_20260628-0704.json --event 2026-06/07 \\
      --osm-features data/raw/lagos-lekki/osm/features.osm --osm-roads data/raw/lagos-lekki/osm/roads.osm
"""

from __future__ import annotations

import argparse
import json

import numpy as np


def replay_max_depth(aoi_id: str, series: str, every_s: float = 600.0) -> tuple[np.ndarray, float]:
    from dryrun.contracts import ScenarioSpec, Storm
    from dryrun.sim import engine, solver
    from evals.validation.drain_down import _series_rain

    _, inp = engine._load_inputs(ScenarioSpec(aoi_id=aoi_id, storm=Storm(total_mm=1, duration_h=1)))
    cum, start = _series_rain(series)
    rows = json.load(open(series))["rows"]
    t_end = len(rows) * 1800.0
    times = list(np.arange(every_s, t_end, every_s)) + [t_end]
    frames, _ = solver.integrate(inp, times, lambda a, b: (cum(b) - cum(a)) / 1000)
    return np.max([d for _, d in frames], axis=0), cum(t_end)


def main() -> None:
    from dryrun import storage
    from evals.validation import hotspots as H

    ap = argparse.ArgumentParser()
    ap.add_argument("--aoi", required=True)
    ap.add_argument("--series", required=True)
    ap.add_argument("--event", required=True, help="hotspots_lekki.json event key, e.g. 2026-06/07")
    ap.add_argument("--hotspots", default="evals/validation/hotspots_lekki.json")
    ap.add_argument("--osm-features")
    ap.add_argument("--osm-roads")
    a = ap.parse_args()
    spots = json.loads(storage.read_local_file(a.hotspots))
    spots["hotspots"] = [h for h in spots["hotspots"] if a.event in h.get("events", [])]
    depth, rain = replay_max_depth(a.aoi, a.series)
    out = H.score_depth(a.aoi, depth, H.geocode(spots, a.aoi, a.osm_features, a.osm_roads))
    out.update(event=a.event, series=a.series, rain_mm=round(rain, 1), n_hotspots_for_event=len(spots["hotspots"]))
    print(json.dumps(out, indent=1, default=float))


if __name__ == "__main__":
    main()
