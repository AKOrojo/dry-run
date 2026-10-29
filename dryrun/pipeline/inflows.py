"""River inflow layer for inland AOIs (owner: Eng A; called by Eng D's pipeline).

Turns USGS gauge hydrographs (evals/validation/usgs.py output) into the optional AOI layer
`inflows.json`, which the engine feeds to the solver as SolverInputs.inflows:

  {"t0_utc": "2025-07-04T07:00",
   "sources": [{"name": ..., "gauges": {"08165500": 1, "08165300": -1},
                "cells": [[row, col], ...], "hydrograph": [[t_s, m3_s], ...]}],
   "note": ...}

A source enters where its river crosses the AOI edge: the river-mask cells on the border nearest its
`entry` point. Its discharge is a signed sum of gauges (a residual such as Hunt minus North Fork is an
estimate for an ungauged fork), interpolated onto STEP_S steps from t0 and clipped at 0. The engine
interpolates linearly and holds the last value after the end.
"""

from __future__ import annotations

import datetime as dt

import numpy as np

from dryrun.contracts import GridSpec

STEP_S = 300
ENTRY_SEARCH_CELLS = 10  # how far along the border to look for the river from the entry point


def _epoch(t: str) -> float:
    return dt.datetime.fromisoformat(t).replace(tzinfo=dt.timezone.utc).timestamp()


def entry_cells(grid: GridSpec, river_mask: np.ndarray, lon: float, lat: float) -> list[list[int]]:
    """River cells on the AOI border within ENTRY_SEARCH_CELLS of the border cell nearest (lon, lat)."""
    w, s, e, n = grid.bounds_wgs84
    col = int(np.clip((lon - w) / (e - w) * grid.nx, 0, grid.nx - 1))
    row = int(np.clip((n - lat) / (n - s) * grid.ny, 0, grid.ny - 1))
    river = np.asarray(river_mask) > 0.5
    border = np.zeros(river.shape, bool)
    border[0, :] = border[-1, :] = border[:, 0] = border[:, -1] = True
    rr, cc = np.nonzero(river & border)
    d = np.maximum(np.abs(rr - row), np.abs(cc - col))  # cells from the entry point
    to_border = min(row, col, grid.ny - 1 - row, grid.nx - 1 - col)
    if d.size == 0 or d.min() > to_border + ENTRY_SEARCH_CELLS:
        raise ValueError(f"no river cell on the AOI border near ({lon}, {lat})")
    keep = d <= d.min() + 1  # the crossing itself and its immediate neighbours along the edge
    return [[int(r), int(c)] for r, c in zip(rr[keep], cc[keep])]


def hydrograph(gauges: dict, weights: dict[str, float], t0_utc: str, hours: float) -> list[list[float]]:
    """Signed sum of gauge discharges on STEP_S steps from t0, clipped at 0 -> [[t_s, m3_s], ...]."""
    t0 = _epoch(t0_utc)
    ts = np.arange(0, hours * 3600 + STEP_S, STEP_S, dtype=np.float64)
    q = np.zeros_like(ts)
    for site, wgt in weights.items():
        rows = gauges[site]["rows"]
        tg = np.array([_epoch(t) for t, _ in rows]) - t0
        qg = np.array([v for _, v in rows], np.float64)
        q += wgt * np.interp(ts, tg, qg)
    return [[float(t), round(float(v), 2)] for t, v in zip(ts, np.maximum(q, 0.0))]


def build_inflows(grid: GridSpec, river_mask: np.ndarray, gauges: dict, t0_utc: str, hours: float,
                  sources: list[dict], note: str = "") -> dict:
    """sources: [{"name", "gauges": {site: +1 | -1}, "entry": [lon, lat]}] -> the inflows.json dict."""
    out = []
    for src in sources:
        out.append({"name": src["name"], "gauges": src["gauges"],
                    "cells": entry_cells(grid, river_mask, *src["entry"]),
                    "hydrograph": hydrograph(gauges, src["gauges"], t0_utc, hours)})
    return {"t0_utc": t0_utc, "sources": out, "note": note}
