"""Surrogate parameter space <-> ScenarioSpec (owner: Eng A). Serving-safe: numpy + contracts only.

Every surrogate sample IS a real ScenarioSpec, so any candidate the sweep ranks can be confirmed
with run_simulation using exactly the interventions it returns.

Parameters (Latin hypercube ranges for the training set):
  total_mm            rain total                    [40, 250]
  duration_h          storm duration                [1, 6]   (centre-peaked)
  tide_m              boundary level                [-0.5, 1.5]
  drain_factor        x existing drains, whole AOI  [0.5, 3]
  add_mm_h            new drains, whole AOI         [0, 60]
  green_mm_h          green infiltration on the AOI's green place   [0, 60]   (< 5 = none)
  pond_depth_m        pond dug in the AOI's pond place              [0, 3]    (< 0.25 = none)
The doc's "green fraction" / "pond volume" are expressed through named places (green_place,
pond_place), because the agent can only target places or polygons; pond volume = depth x area.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np

from dryrun.contracts import DrainUpgrade, GreenInfrastructure, RetentionPond, ScenarioSpec, Storm, TideLevel
from dryrun.sim.solver import DEFAULT_TIDE_M

RANGES = {
    "total_mm": (40.0, 250.0),
    "duration_h": (1.0, 6.0),
    "tide_m": (-0.5, 1.5),
    "drain_factor": (0.5, 3.0),
    "add_mm_h": (0.0, 60.0),
    "green_mm_h": (0.0, 60.0),
    "pond_depth_m": (0.0, 3.0),
}
FEATURES = tuple(RANGES)
TARGETS = ("buildings_flooded", "buildings_flooded_severe", "people_exposed", "road_km_impassable",
           "flooded_area_km2")
GREEN_MIN_MM_H = 5.0
POND_MIN_M = 0.25


@dataclass(frozen=True)
class AOIConfig:
    """Where the surrogate's green and pond interventions go for one AOI (stored with the model)."""

    aoi_id: str
    green_place: str
    pond_place: str
    sim_hours: float = 6.0


DEFAULT_CONFIGS = {
    "fixture-synthetic": AOIConfig("fixture-synthetic", "North Estate (synthetic)", "Open Field (synthetic)"),
    # Largest open_land polygon for the pond (0.20 km2; 4 building cells, so pond candidates carry a
    # small buildings_in_ponds); a dense, mostly sealed neighbourhood for green.
    "lagos-lekki-v1": AOIConfig("lagos-lekki-v1", "Lekki Phase 1", "Open land near Ajah"),
    "lagos-lekki-v2": AOIConfig("lagos-lekki-v2", "Lekki Phase 1", "Open land near Ajah"),
    # v3: the drain network (contract 0.8.0); drain_factor scales the channels, add_mm_h stays a sink
    "lagos-lekki-v3": AOIConfig("lagos-lekki-v3", "Lekki Phase 1", "Open land near Ajah"),
}


def config_dict(cfg: AOIConfig) -> dict:
    return asdict(cfg)


def interventions(p: dict, cfg: AOIConfig) -> list:
    out = []
    if abs(p["drain_factor"] - 1) > 1e-9 or p["add_mm_h"] > 0:
        out.append(DrainUpgrade(capacity_factor=round(p["drain_factor"], 3), add_mm_h=round(p["add_mm_h"], 2)))
    if p["green_mm_h"] >= GREEN_MIN_MM_H:
        out.append(GreenInfrastructure(place=cfg.green_place, infiltration_mm_h=round(p["green_mm_h"], 2)))
    if p["pond_depth_m"] >= POND_MIN_M:
        out.append(RetentionPond(place=cfg.pond_place, depth_m=round(p["pond_depth_m"], 3)))
    if p["tide_m"] is not None and abs(p["tide_m"] - DEFAULT_TIDE_M) > 1e-9:  # default tide = no intervention
        out.append(TideLevel(boundary_level_m=round(p["tide_m"], 3)))
    return out


def scenario(p: dict, cfg: AOIConfig) -> ScenarioSpec:
    return ScenarioSpec(aoi_id=cfg.aoi_id, storm=Storm(total_mm=round(p["total_mm"], 2),
                                                       duration_h=round(p["duration_h"], 3)),
                        interventions=interventions(p, cfg), sim_hours=cfg.sim_hours)


def feature_row(p: dict) -> list[float]:
    """Model input. Below-threshold green/pond are zeroed to match what scenario() actually builds."""
    r = dict(p)
    r["green_mm_h"] = r["green_mm_h"] if r["green_mm_h"] >= GREEN_MIN_MM_H else 0.0
    r["pond_depth_m"] = r["pond_depth_m"] if r["pond_depth_m"] >= POND_MIN_M else 0.0
    return [float(r[k]) for k in FEATURES]


def latin_hypercube(n: int, seed: int = 0) -> list[dict]:
    """n samples, one per stratum in every dimension (deterministic for a seed)."""
    rng = np.random.default_rng(seed)
    cols = []
    for lo, hi in RANGES.values():
        u = (rng.permutation(n) + rng.random(n)) / n
        cols.append(lo + u * (hi - lo))
    return [dict(zip(FEATURES, map(float, row))) for row in np.array(cols).T]
