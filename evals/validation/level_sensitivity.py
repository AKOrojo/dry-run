"""Lagoon / sea level sensitivity per coastal AOI (owner: Eng A).

Re-runs each AOI's reference storm with the water held at boundary_mask cells (open lagoon/sea, plus the edge
outflow ring where an AOI has one) at LEVELS_M, EGM2008 metres, and writes flooded km2 and buildings with water
close by to dryrun/presets/level_sensitivity.json (served at GET /api/aoi/{aoi_id}/level_sensitivity).
-0.5 m is the solver's default level, so that row is the reference run itself.

  python evals/validation/level_sensitivity.py
"""

from __future__ import annotations

import json
import os

LEVELS_M = (-0.5, 0.5, 1.0, 1.5)
REFERENCE = {
    "lagos-lekki-v2": {"label": "120 mm / 3 h", "storm": {"total_mm": 120, "duration_h": 3},
                       "note": "the lagoon fringe is low (14,667 land cells below 1.5 m), so the lagoon level matters"},
    "nyc-queens-v0": {"label": "Ida 1 Sep 2021 (LaGuardia gauge)",
                      "storm": {"total_mm": 118, "duration_h": 4, "pattern": "center_peaked"}, "sim_hours": 8,
                      "note": "sea level barely matters here: Queens land is high (5th percentile 5.6 m; 194 land cells below 1.5 m), so even +1.5 m adds under 0.02 km2; Ida flooding was rain, not surge"},
    # drainage AOIs (0.8.0): the level also backs up the drain and sewer outfalls
    "lagos-lekki-v3": {"label": "120 mm / 3 h", "storm": {"total_mm": 120, "duration_h": 3},
                       "note": "the lagoon fringe is low (14,667 land cells below 1.5 m), so the lagoon level matters; it also backs up the open drains, which outfall to the lagoon with no flap gates"},
    "nyc-queens-v1": {"label": "Ida 1 Sep 2021 (LaGuardia gauge)",
                      "storm": {"total_mm": 118, "duration_h": 4, "pattern": "center_peaked"}, "sim_hours": 8,
                      "note": "Queens land is high (5th percentile 5.6 m; 194 land cells below 1.5 m) and the sewer outfalls have flap gates, so +1.5 m adds only 0.09 km2 (it slows the outfalls); Ida flooding was rain, not surge"},
}
OUT = os.path.join(os.path.dirname(__file__), "..", "..", "dryrun", "presets", "level_sensitivity.json")


def table(aoi_id: str, ref: dict) -> dict:
    from dryrun.contracts import ScenarioSpec, TideLevel
    from dryrun.sim.engine import run_scenario

    rows = []
    for level in LEVELS_M:
        spec = ScenarioSpec(aoi_id=aoi_id, storm=ref["storm"], sim_hours=ref.get("sim_hours", 6.0),
                            interventions=[] if level == -0.5 else [TideLevel(boundary_level_m=level)])
        st = run_scenario(spec).stats
        rows.append({"level_m": level, "run_id": spec.run_id(), "flooded_km2": round(st.flooded_area_km2, 3),
                     "buildings": st.buildings_flooded})
        print(aoi_id, rows[-1], flush=True)
    return {"storm": ref["label"], "datum": "EGM2008 m; -0.5 m is the default level", "rows": rows,
            "note": ref["note"]}


def main() -> None:
    out = {aoi: table(aoi, ref) for aoi, ref in REFERENCE.items()}
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1)
        f.write("\n")


if __name__ == "__main__":
    main()
