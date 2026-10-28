"""FAKE backend: cheap downhill-spreading water so the UI/agent work on Day 1.

It is NOT a hydraulic model. It conserves mass and responds to every
intervention in the right direction, which is all Eng B/C/D need until
Eng A's local-inertial solver (solver.py) lands. Manifests produced by it
carry backend="fake" and the UI must badge them "PLACEHOLDER PHYSICS".
"""

from __future__ import annotations

import numpy as np

from dryrun.contracts import ScenarioSpec
from dryrun.sim.interventions import SolverInputs, rain_rate_mm_h, t_end_s


def simulate(inp: SolverInputs, spec: ScenarioSpec, cell_m: float):
    ny, nx = inp.dem.shape
    area = cell_m * cell_m
    h = np.zeros((ny, nx), np.float32)
    dt = 60.0
    out_every = spec.output_interval_min * 60
    t_end = t_end_s(spec)
    led = dict(rain_volume_m3=0.0, drained_volume_m3=0.0, infiltrated_volume_m3=0.0, boundary_outflow_m3=0.0)
    frames: list[tuple[int, np.ndarray]] = [(0, h.copy())]
    t = 0
    while t < t_end:
        rain = rain_rate_mm_h(spec, t) / 1000 / 3600 * dt
        h += rain
        led["rain_volume_m3"] += rain * h.size * area

        inf = np.minimum(h, inp.infiltration_mm_h / 1000 / 3600 * dt)
        h -= inf
        led["infiltrated_volume_m3"] += float(inf.sum()) * area
        snk = np.minimum(h, inp.drain_sink_mm_h / 1000 / 3600 * dt)
        h -= snk
        led["drained_volume_m3"] += float(snk.sum()) * area

        # Spread: move a fraction of the water-surface difference to lower 4-neighbours.
        for _ in range(4):
            eta = inp.dem + h
            flux = np.zeros_like(h)
            for axis, shift in ((0, 1), (0, -1), (1, 1), (1, -1)):
                # np.roll(a, s)[i] == a[i - s]  -> q[i] is flow from cell i to cell i - s
                nb = np.roll(eta, shift, axis)
                q = np.minimum(np.clip(eta - nb, 0, None) * 0.2, h * 0.24)
                edge = 0 if shift == 1 else -1  # cells whose "neighbour" wrapped around
                if axis == 0:
                    q[edge, :] = 0
                else:
                    q[:, edge] = 0
                flux -= q
                flux += np.roll(q, -shift, axis)  # receiver j gets q[j + s]
            h = np.maximum(h + flux, 0)

        # Open-water boundary (boundary_mask: lagoon/sea, wherever it is): water above tide level
        # leaves the domain. One-directional in the fake; the real solver also models inflow.
        level = -0.5 if inp.tide_level_m is None else inp.tide_level_m
        b = inp.boundary_mask if inp.boundary_mask is not None else np.zeros_like(h, bool)
        excess = np.minimum(np.clip(inp.dem + h - level, 0, None), h) * b
        h -= excess
        led["boundary_outflow_m3"] += float(excess.sum()) * area

        t += int(dt)
        if t % out_every == 0 or t >= t_end:
            frames.append((t, h.copy()))
    if frames[-1][0] != t:  # CONTRACT: last frame is always the final state
        frames.append((t, h.copy()))
    return frames, led
