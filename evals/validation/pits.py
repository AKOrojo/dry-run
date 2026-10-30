"""Closed depressions in an AOI's DEM, and how much of the model's lingering water sits in them (owner: Eng A).

Priority-flood fill (Barnes et al. 2014) from the outlets (open-water boundary cells and the grid edge) gives
each cell's depression depth: how much water it holds that can never drain overland. Water held there can
only leave through infiltration and the drain sink. With --series/--report-at the drain-down run from
drain_down.py is repeated, and the wet land at the report time is split by depression depth.

  python evals/validation/pits.py --aoi lagos-lekki-v1 --series evals/validation/imerg_lagos_20260709-12.json \\
      --report-at 2026-07-12T05:29
"""

from __future__ import annotations

import argparse
import heapq
import json

import numpy as np


def fill_depth(dem: np.ndarray, outlet: np.ndarray) -> np.ndarray:
    """Depth each cell must be raised by to drain to an outlet (0 outside closed depressions)."""
    ny, nx = dem.shape
    filled = dem.astype(np.float64).copy()
    done = np.zeros((ny, nx), bool)
    edge = outlet.copy()
    edge[0, :] = edge[-1, :] = edge[:, 0] = edge[:, -1] = True
    heap = [(filled[r, c], r, c) for r, c in zip(*np.nonzero(edge))]
    heapq.heapify(heap)
    done[edge] = True
    while heap:
        h, r, c = heapq.heappop(heap)
        for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):  # the solver's 4 faces
            rr, cc = r + dr, c + dc
            if 0 <= rr < ny and 0 <= cc < nx and not done[rr, cc]:
                done[rr, cc] = True
                filled[rr, cc] = max(filled[rr, cc], h)
                heapq.heappush(heap, (filled[rr, cc], rr, cc))
    return filled - dem


def run(aoi_id: str, series: str | None, report_at: list[str] | None) -> dict:
    from dryrun.contracts import ScenarioSpec, Storm
    from dryrun.sim import engine, exposure

    aoi, inp = engine._load_inputs(ScenarioSpec(aoi_id=aoi_id, storm=Storm(total_mm=1, duration_h=1)))
    land = ~inp.exclude_mask
    pit = fill_depth(np.asarray(inp.dem), np.asarray(inp.boundary_mask, bool))
    cell_km2 = aoi.grid.dx_m * aoi.grid.dy_m / 1e6
    out = {"aoi_id": aoi_id, "land_in_depressions_km2": {}, "storage_m3": {}}
    for th in (0.05, 0.15, 0.3, 0.5, 1.0, 2.0):
        out["land_in_depressions_km2"][f">={th}m"] = round(float(((pit >= th) & land).sum() * cell_km2), 2)
    out["storage_m3"]["all_depressions"] = round(float(np.where(land, pit, 0).sum() * cell_km2 * 1e6))
    out["storage_mm_over_land"] = round(float(np.where(land, pit, 0).sum() / land.sum() * 1000), 1)
    if series:
        import datetime as dt

        from dryrun.sim import solver
        from evals.validation.drain_down import _series_rain

        cum, start = _series_rain(series)
        times = sorted((dt.datetime.fromisoformat(t) - start).total_seconds() for t in report_at)
        frames, _ = solver.integrate(inp, times, lambda a, b: (cum(b) - cum(a)) / 1000)
        rows = []
        for t, d in frames[1:]:
            wet = (d >= exposure.FLOODED_M) & land
            held = wet & (pit >= exposure.FLOODED_M)
            rows.append({"utc": (start + dt.timedelta(seconds=t)).isoformat(timespec="minutes"),
                         "wet_land_km2": round(float(wet.sum() * cell_km2), 3),
                         "wet_in_depressions_km2": round(float(held.sum() * cell_km2), 3),
                         "share_in_depressions": round(float(held.sum() / max(wet.sum(), 1)), 3),
                         "median_depression_depth_of_wet_m": round(float(np.median(pit[wet])), 2) if wet.any() else None,
                         "stored_land_m3": round(float(np.where(land, d, 0).sum() * cell_km2 * 1e6)),
                         "stored_in_depressions_m3": round(float(np.where(land, np.minimum(d, pit), 0).sum()
                                                                 * cell_km2 * 1e6))})
        out["drain_down"] = rows
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--aoi", required=True)
    ap.add_argument("--series")
    ap.add_argument("--report-at", nargs="+")
    a = ap.parse_args()
    print(json.dumps(run(a.aoi, a.series, a.report_at), indent=1))


if __name__ == "__main__":
    main()
