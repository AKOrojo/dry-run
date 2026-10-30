"""Derived per-run maps from the stored depth frames (owner: Eng A; route in api/main.py).

Lives outside dryrun/sim on purpose: SOLVER_VERSION hashes the sim sources, so code here never changes
run_ids and the warmed runs stay valid. Nothing is added to RunManifest; the UI builds
`/api/runs/{run_id}/derived/{kind}.png` (and `.json` for the legend) from the run_id.

  arrival   minutes from storm start until a cell first reaches FLOODED_M (0.15 m)
  duration  minutes a cell spends at or above FLOODED_M
  events    key events with map points (first road cut, largest jump in cut roads, peak flooded area) and
            per named place: when 10 % of its land is wet, its first road cut, a label point (.json only)

`series()` (depth at one cell for every frame) and `boundary_geojson()` (the lagoon/sea outline) are served
live by the API from in-process caches rather than written to the bucket.

Both come from the frames, so they are accurate to the nearest frame (a wet frame counts the interval
before it). Cells that never reach the threshold, and permanent water (the run's exclude mask, as in the
depth frames), are transparent. Colour: the design system's `hazard` hue at stepped opacity (Eng B).
"""

from __future__ import annotations

import io
import json
import threading
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

import numpy as np
from PIL import Image

from dryrun import storage
from dryrun.sim import exposure

MAPS = ("arrival", "duration")
KINDS = MAPS + ("events",)  # every kind has a .json; MAPS also have a .png
HAZARD_RGB = (0xFF, 0x6B, 0x2C)
LONG_RUN_MIN = 360  # runs longer than this (the Texas replay, 12 h) get wider bins


def edges_min(kind: str, run_min: float) -> list[int]:
    """Bin edges in minutes, fixed per run length so A/B runs share a legend. Set from the warmed presets:
    Lagos 120 mm / 3 h arrival quartiles 80/100/120 min, duration 190/260/290 of 360; Texas replay arrival
    180/230/270 (the river front reaches the valley 3-5 h in), duration 300/450/530 of 720."""
    long = run_min > LONG_RUN_MIN
    if kind == "arrival":
        return [180, 240, 300] if long else [60, 90, 120]
    return [300, 420, 540] if long else [60, 180, 300]


ALPHAS = {"arrival": [1.0, 0.72, 0.48, 0.28],   # earliest arrival is the strongest
          "duration": [0.28, 0.48, 0.72, 1.0]}  # longest duration is the strongest


STACK_RUNS = 4  # runs whose frame stacks stay in memory per instance (~13 MB each for Lagos, float16)
_stacks: OrderedDict[str, tuple[np.ndarray, np.ndarray]] = OrderedDict()
_stack_lock = threading.Lock()
_fill_locks: dict[str, threading.Lock] = {}
_IO = ThreadPoolExecutor(16)


def stack(run_id: str) -> tuple[np.ndarray, np.ndarray]:
    """(t_s[frames], depth[frames, ny, nx] float16) for a done run, read in one parallel pass and kept in an
    LRU. Concurrent first requests for the same run wait for one fill instead of each reading every frame."""
    with _stack_lock:
        if run_id in _stacks:
            _stacks.move_to_end(run_id)
            return _stacks[run_id]
        fill = _fill_locks.setdefault(run_id, threading.Lock())
    with fill:
        with _stack_lock:
            if run_id in _stacks:
                return _stacks[run_id]
        m = storage.load_run(run_id)
        raw = list(_IO.map(lambda f: storage.read_run_file(run_id, f.depth), m.frames))
        depth = np.stack([np.load(io.BytesIO(b)).astype(np.float16) for b in raw])
        out = (np.array([f.t_s for f in m.frames]), depth)
        with _stack_lock:
            _stacks[run_id] = out
            while len(_stacks) > STACK_RUNS:
                _stacks.popitem(last=False)
            _fill_locks.pop(run_id, None)
        return out


def _exclude(m) -> np.ndarray:
    """The run's own exclude mask (permanent water plus any pond the scenario adds), as the engine used."""
    from dryrun.sim import engine

    return engine._load_inputs(m.scenario)[1].exclude_mask


def compute(run_id: str) -> dict[str, np.ndarray]:
    """{"arrival": minutes or NaN, "duration": minutes or NaN} on the AOI grid."""
    m = storage.load_run(run_id)
    excl = _exclude(m)
    ts, depth = stack(run_id)
    wet = (depth >= exposure.FLOODED_M) & ~excl
    ever = wet.any(axis=0)
    arrival = np.where(ever, ts[np.argmax(wet, axis=0)] / 60, np.nan)
    dt = np.diff(ts, prepend=ts[0]) / 60  # a wet frame counts the interval before it
    duration = np.where(ever, np.tensordot(dt, wet, axes=1), np.nan)
    return {"arrival": arrival, "duration": duration}


def png(kind: str, minutes: np.ndarray, edges: list[int]) -> bytes:
    rgba = np.zeros(minutes.shape + (4,), np.uint8)
    seen = ~np.isnan(minutes)
    alpha = np.array(ALPHAS[kind])[np.digitize(np.where(seen, minutes, 0), edges, right=True)]
    rgba[..., :3] = HAZARD_RGB
    rgba[..., 3] = np.where(seen, np.round(alpha * 255), 0).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "PNG", compress_level=6)
    return buf.getvalue()


def legend(kind: str, edges: list[int], m) -> dict:
    return {"kind": kind, "units": "min", "edges_min": edges, "alphas": ALPHAS[kind],
            "rgb": "#{:02X}{:02X}{:02X}".format(*HAZARD_RGB), "threshold_m": exposure.FLOODED_M,
            "frame_interval_min": round((m.frames[1].t_s - m.frames[0].t_s) / 60, 2) if len(m.frames) > 1 else None,
            "run_min": round(m.frames[-1].t_s / 60, 1),
            "note": f"to the nearest frame; threshold {exposure.FLOODED_M} m is an assumption"}


def rel(kind: str, ext: str) -> str:
    return f"derived/{kind}.{ext}"


def derive(run_id: str) -> None:
    """Write every kind (idempotent: outputs are immutable per run). A kind's .json is written last, so its
    presence means the kind is complete."""
    m = storage.load_run(run_id)
    run_min = m.frames[-1].t_s / 60
    for kind, minutes in compute(run_id).items():
        edges = edges_min(kind, run_min)
        storage.write_run_file(run_id, rel(kind, "png"), png(kind, minutes, edges), "image/png")
        storage.write_run_file(run_id, rel(kind, "json"), json.dumps(legend(kind, edges, m)).encode(),
                               "application/json")
    storage.write_run_file(run_id, rel("events", "json"), json.dumps(events(run_id)).encode(), "application/json")


# ------------------------------------------------------------------ events
def _lonlat(grid, r: int, c: int) -> list[float]:
    w, s, e, n = grid.bounds_wgs84
    return [round(float(w + (c + 0.5) / grid.nx * (e - w)), 5), round(float(n - (r + 0.5) / grid.ny * (n - s)), 5)]


@lru_cache(maxsize=8)
def place_masks(aoi_id: str) -> tuple[tuple[str, str, np.ndarray], ...]:
    """(name, kind, cell mask) for every Polygon in the AOI's places layer."""
    from PIL import ImageDraw

    g = storage.load_aoi(aoi_id).grid
    w, s, e, n = g.bounds_wgs84
    out = []
    for f in json.loads(storage.load_aoi_file(aoi_id, "places"))["features"]:
        if f["geometry"]["type"] != "Polygon":
            continue
        img = Image.new("1", (g.nx, g.ny), 0)
        ring = [((x - w) / (e - w) * g.nx, (n - y) / (n - s) * g.ny) for x, y in f["geometry"]["coordinates"][0]]
        ImageDraw.Draw(img).polygon(ring, fill=1)
        out.append((f["properties"]["name"], f["properties"].get("kind", ""), np.array(img, bool)))
    return tuple(out)


def _label_point(grid, mask: np.ndarray) -> list[float]:
    rr, cc = np.nonzero(mask)
    i = int(np.argmin((rr - rr.mean()) ** 2 + (cc - cc.mean()) ** 2))  # a cell inside, nearest the centroid
    return _lonlat(grid, rr[i], cc[i])


def _hhmm(t_s: float) -> str:
    return f"T+{int(t_s // 3600):02d}:{int(t_s % 3600 // 60):02d}"


def events(run_id: str) -> dict:
    """Key events and per-place timings. Counts and times of run-wide events are the ENGINE's (timeseries,
    float32); map points come from the stored float16 frames, which can differ by a few edges at the 0.3 m
    line. No "deepest cell" point: the deepest land cell tends to sit against a closed domain edge."""
    from dryrun.sim import interventions

    m = storage.load_run(run_id)
    aoi_id = m.scenario.aoi_id
    g = storage.load_aoi(aoi_id).grid
    excl = _exclude(m)
    ponds = interventions.pond_mask(m.scenario, g, storage.load_raster(aoi_id, "exclude_mask") > 0.5)
    ea = exposure.edge_arrays(aoi_id)
    ts, depth = stack(run_id)
    cuts = np.array([exposure.cut_mask(aoi_id, d.astype(np.float32), excl, ponds) for d in depth])
    places = place_masks(aoi_id)
    on_place = {name: exposure.edges_touching(ea, mk) for name, _, mk in places}
    ends = np.append(ea.starts[1:], len(ea.flat))
    series = m.timeseries

    def newly_cut(j: int) -> np.ndarray:
        return cuts[j] & ~cuts[j - 1] if j else cuts[j]

    def cut_event(label: str, i: int, count: int, kind: str) -> dict:
        j = i
        while j < len(ts) - 1 and not newly_cut(j).any():
            j += 1  # the float16 frame may cross the line one frame late
        new = newly_cut(j)
        by_place = {name: int((new & on).sum()) for name, on in on_place.items() if (new & on).any()}
        top = max(by_place, key=by_place.get) if by_place else None
        idx = np.nonzero(new)[0]
        cells = np.concatenate([ea.flat[ea.starts[k]:ends[k]] for k in idx]) if len(idx) else np.zeros(0, int)
        if top is not None:
            cells = cells[next(mk for name, _, mk in places if name == top).ravel()[cells]]
        if not len(cells):
            return {}
        r, c = np.divmod(cells, g.nx)
        k = int(np.argmin((r - np.median(r)) ** 2 + (c - np.median(c)) ** 2))  # a real cut road cell
        return {"event": label, "kind": kind, "t_s": int(series.t_s[i]), "t": _hhmm(series.t_s[i]),
                "count": count, "point": _lonlat(g, r[k], c[k]), "place": top,
                "new_cuts_by_place": dict(sorted(by_place.items(), key=lambda x: -x[1])[:5])}

    out = []
    cut_series = np.array(series.edges_cut)
    if cut_series.any():
        i0 = int(np.argmax(cut_series > 0))
        out.append(cut_event("first road impassable", i0, int(cut_series[i0]), "first_cut"))
        jumps = np.diff(cut_series, prepend=0)
        i1 = int(np.argmax(jumps))
        if i1 != i0:
            out.append(cut_event(f"largest jump in cut roads (+{int(jumps[i1])})", i1, int(jumps[i1]), "cut_jump"))
    area = np.array(series.flooded_area_km2)
    if area.any():
        p = int(np.argmax(area))
        wet = (depth[p] >= exposure.FLOODED_M) & ~excl
        cell_km2 = g.dx_m * g.dy_m / 1e6
        by = {name: float((wet & mk).sum() * cell_km2) for name, _, mk in places}
        top = max(by, key=by.get) if by and max(by.values()) > 0 else None
        out.append({"event": "peak flooded area", "kind": "peak_area", "t_s": int(series.t_s[p]),
                    "t": _hhmm(series.t_s[p]), "flooded_area_km2": float(area[p]), "place": top,
                    "place_flooded_km2": round(by[top], 2) if top else None,
                    "point": _label_point(g, next(mk for n_, _, mk in places if n_ == top)) if top else None})
    out = [e for e in out if e]

    per = []
    for name, kind, mk in places:
        land = mk & ~excl
        if not land.any():
            continue
        frac = ((depth >= exposure.FLOODED_M) & land).reshape(len(ts), -1).sum(axis=1) / land.sum()
        i10 = np.nonzero(frac >= 0.10)[0]
        cut_here = np.nonzero((cuts & on_place[name]).any(axis=1))[0]
        per.append({"place": name, "kind": kind, "label_point": _label_point(g, mk),
                    "ten_pct_wet_s": int(ts[i10[0]]) if len(i10) else None,
                    "ten_pct_wet": _hhmm(ts[i10[0]]) if len(i10) else None,
                    "first_road_cut_s": int(ts[cut_here[0]]) if len(cut_here) else None,
                    "first_road_cut": _hhmm(ts[cut_here[0]]) if len(cut_here) else None,
                    "peak_pct_wet": round(float(100 * frac.max()), 1)})
    return {"run_id": run_id, "aoi_id": aoi_id, "threshold_m": {"flooded": exposure.FLOODED_M,
            "road_impassable": exposure.PASSABLE_M}, "frame_interval_s": int(ts[1] - ts[0]) if len(ts) > 1 else None,
            "events": out, "places": per,
            "note": "times to the nearest frame; run-wide counts from the engine timeseries; per-place values and "
                    "map points from the stored float16 frames; thresholds are assumptions"}


# ------------------------------------------------------------------ live: point series, boundary
def series(run_id: str, lon: float, lat: float) -> dict:
    """Depth at one cell for every frame. Raises ValueError outside the AOI."""
    m = storage.load_run(run_id)
    g = storage.load_aoi(m.scenario.aoi_id).grid
    w, s, e, n = g.bounds_wgs84
    col, row = int(np.floor((lon - w) / (e - w) * g.nx)), int(np.floor((n - lat) / (n - s) * g.ny))
    if not (0 <= row < g.ny and 0 <= col < g.nx):
        raise ValueError("point outside AOI")
    ts, depth = stack(run_id)
    d = depth[:, row, col].astype(np.float64)

    def first(th):
        i = np.nonzero(d >= th)[0]
        return int(ts[i[0]]) if len(i) else None

    return {"run_id": run_id, "lon": lon, "lat": lat, "cell": [row, col], "cell_center": _lonlat(g, row, col),
            "permanent_water": bool(_exclude(m)[row, col]),
            "t_s": ts.tolist(), "depth_m": np.round(d, 3).tolist(), "max_depth_m": round(float(d.max()), 3),
            "first_flooded_s": first(exposure.FLOODED_M), "first_impassable_s": first(exposure.PASSABLE_M),
            "threshold_m": {"flooded": exposure.FLOODED_M, "road_impassable": exposure.PASSABLE_M}}


def _trace(mask: np.ndarray) -> list[list[tuple[int, int]]]:
    """Outline of a cell mask as polylines of grid-corner (row, col) points. Cells outside the grid count as
    inside the mask, so the AOI border itself is never drawn; collinear points are dropped."""
    m = np.pad(mask, 1, mode="edge")
    nxt: dict[tuple[int, int], list[tuple[int, int]]] = {}
    ny, nx = mask.shape
    for r in range(ny):  # one directed edge per cell side facing a non-mask cell (mask on the left)
        for c in np.nonzero(mask[r])[0]:
            if not m[r, c + 1]:                     # north side, walk west
                nxt.setdefault((r, c + 1), []).append((r, c))
            if not m[r + 2, c + 1]:                 # south side, walk east
                nxt.setdefault((r + 1, c), []).append((r + 1, c + 1))
            if not m[r + 1, c]:                     # west side, walk south
                nxt.setdefault((r, c), []).append((r + 1, c))
            if not m[r + 1, c + 2]:                 # east side, walk north
                nxt.setdefault((r + 1, c + 1), []).append((r, c + 1))
    ins = {}
    for a, bs in nxt.items():
        for b in bs:
            ins[b] = ins.get(b, 0) + 1
    starts = [a for a in nxt if ins.get(a, 0) == 0] + list(nxt)  # open chains first, then closed rings
    lines = []
    for a in starts:
        while nxt.get(a):
            line = [a]
            cur = a
            while nxt.get(cur):
                cur = nxt[cur].pop()
                line.append(cur)
                if cur == a:
                    break
            keep = [line[0]] + [p for i, p in enumerate(line[1:-1], 1)
                                if (line[i - 1][0] - p[0], line[i - 1][1] - p[1]) != (p[0] - line[i + 1][0], p[1] - line[i + 1][1])] \
                + [line[-1]]
            lines.append(keep)
    return lines


@lru_cache(maxsize=8)
def boundary_geojson(aoi_id: str) -> bytes:
    """The open-water boundary (boundary_mask: lagoon and sea, held at the boundary level) as a GeoJSON
    MultiLineString on cell edges. Inland AOIs (river inflows) get an empty collection: their boundary is a
    river outlet, not a water body a user can raise."""
    from dryrun.sim.solver import DEFAULT_TIDE_M

    aoi = storage.load_aoi(aoi_id)
    if "inflows" in aoi.layers:
        return json.dumps({"type": "FeatureCollection", "features": []}).encode()
    g = aoi.grid
    w, s, e, n = g.bounds_wgs84
    lines = _trace(storage.load_raster(aoi_id, "boundary_mask") > 0.5)
    coords = [[[round(w + c / g.nx * (e - w), 6), round(n - r / g.ny * (n - s), 6)] for r, c in ln] for ln in lines]
    feat = {"type": "Feature", "geometry": {"type": "MultiLineString", "coordinates": coords},
            "properties": {"kind": "sea_lagoon", "default_level_m": DEFAULT_TIDE_M,
                           "note": "open water held at one level for the whole run (the tide intervention sets it)"}}
    return json.dumps({"type": "FeatureCollection", "features": [feat]}).encode()


def exists(run_id: str, kind: str) -> bool:
    return storage._exists("runs", f"{run_id}/{rel(kind, 'json')}")
