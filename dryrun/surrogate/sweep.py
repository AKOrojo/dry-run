"""surrogate_sweep tool backend (owner: Eng A; tool spec + dispatch branch in agent/tools.py, Eng C reviews).

Screens a grid of intervention combinations for one storm in milliseconds with the LightGBM
emulator and returns them ranked. Predictions are SCREENING ONLY: every result carries
is_surrogate=True, has no run_id, and cannot be cited (the verifier only accepts stored run stats).
The agent must confirm the winner with run_simulation using the returned `interventions` verbatim.
"""

from __future__ import annotations

import itertools

import numpy as np

from dryrun.surrogate import features as F
from dryrun.surrogate.model import load

GRID = {
    "drain_factor": (1.0, 1.5, 2.0, 3.0),
    "add_mm_h": (0.0, 20.0, 40.0),
    "green_mm_h": (0.0, 40.0),
    "pond_depth_m": (0.0, 2.0),
}
OBJECTIVES = F.TARGETS


def _effort(p: dict) -> float:
    """Rough relative effort, only to break near-ties toward smaller plans (not a cost model)."""
    return round((p["drain_factor"] - 1) / 2 + p["add_mm_h"] / 40 + (p["green_mm_h"] > 0) + (p["pond_depth_m"] > 0), 2)


def surrogate_sweep(aoi_id: str, total_mm: float, duration_h: float, tide_m: float | None = None,
                    objective: str = "buildings_flooded", top_k: int = 5) -> dict:
    if objective not in OBJECTIVES:
        raise ValueError(f"objective must be one of {OBJECTIVES}")
    s = load(aoi_id)
    cfg = F.AOIConfig(**s.config)
    tide = F.DEFAULT_TIDE_M if tide_m is None else float(tide_m)
    combos = [dict(zip(GRID, v)) for v in itertools.product(*GRID.values())]
    params = [{"total_mm": float(total_mm), "duration_h": float(duration_h), "tide_m": tide, **c} for c in combos]
    pred = s.predict(np.array([F.feature_row(p) for p in params]))
    base_i = next(i for i, c in enumerate(combos) if c == {"drain_factor": 1.0, "add_mm_h": 0.0,
                                                          "green_mm_h": 0.0, "pond_depth_m": 0.0})

    def stats(i):
        return {t: (int(round(v[i])) if t.startswith(("buildings", "people")) else round(float(v[i]), 3))
                for t, v in pred.items()}

    # Predictions closer than a quarter of the cross-validated MAE are indistinguishable: prefer the smaller plan.
    tie = max(0.25 * (s.metrics()[objective]["mae"] or 0.0), 1e-9)
    order = sorted((i for i in range(len(combos)) if i != base_i),
                   key=lambda i: (round(float(pred[objective][i]) / tie), _effort(combos[i])))
    cands = []
    for rank, i in enumerate(order[:max(1, min(int(top_k), 10))], start=1):
        ivs = F.interventions(params[i], cfg)
        cands.append({"rank": rank, "interventions": [iv.model_dump(mode="json", exclude_none=True) for iv in ivs],
                      "predicted": stats(i), "effort": _effort(combos[i])})
    warnings = []
    for k, v in (("total_mm", total_mm), ("duration_h", duration_h), ("tide_m", tide)):
        lo, hi = F.RANGES[k]
        if not lo <= v <= hi:
            warnings.append(f"{k}={v} is outside the training range [{lo}, {hi}]: predictions are extrapolated")
    out = {"aoi_id": aoi_id, "is_surrogate": True, "objective": objective,
           "note": "SCREENING ONLY: surrogate predictions have no run_id and cannot be cited. Confirm the "
                   "candidate you recommend with run_simulation using its interventions verbatim, then cite that run.",
           "baseline_predicted": stats(base_i), "candidates": cands, "model_metrics": s.metrics(),
           "places": {"green": cfg.green_place, "pond": cfg.pond_place}}
    if warnings:
        out["warning"] = " ".join(warnings)
    return out
