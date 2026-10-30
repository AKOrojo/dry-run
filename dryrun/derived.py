"""Derived per-run maps from the stored depth frames (owner: Eng A; route in api/main.py).

Lives outside dryrun/sim on purpose: SOLVER_VERSION hashes the sim sources, so code here never changes
run_ids and the warmed runs stay valid. Nothing is added to RunManifest; the UI builds
`/api/runs/{run_id}/derived/{kind}.png` (and `.json` for the legend) from the run_id.

  arrival   minutes from storm start until a cell first reaches FLOODED_M (0.15 m)
  duration  minutes a cell spends at or above FLOODED_M
  velocity  depth-averaged flow (u east, v north, m/s) per frame on ~90 m blocks, PNG-encoded (.json manifest)
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
KINDS = MAPS + ("events", "velocity")  # every kind has a .json; MAPS also have a .png, velocity one per frame
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
    return _inputs_for(m.run_id, m.scenario.model_dump_json()).exclude_mask


@lru_cache(maxsize=16)  # per run: the hover route calls this on every request, and applying interventions is not free
def _inputs_for(run_id: str, scenario_json: str):
    """The solver inputs the engine built for this run (interventions applied), arrays read-only."""
    from dryrun.contracts import ScenarioSpec
    from dryrun.sim import engine

    inp = engine._load_inputs(ScenarioSpec.model_validate_json(scenario_json))[1]
    for a in (inp.exclude_mask, inp.dem, inp.manning, inp.boundary_mask):
        if isinstance(a, np.ndarray):
            a.setflags(write=False)
    return inp


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


EVENTS_REV = 2  # bump when events() changes: outputs are cached per run, so a new rev is a new object
VELOCITY_REV = 1


def rel(kind: str, ext: str) -> str:
    """Object path. events and velocity carry their revision, so a fix reaches already-derived runs on the next
    derive."""
    if kind == "events":
        return f"derived/events.v{EVENTS_REV}.json"
    if kind == "velocity":
        return f"derived/velocity.v{VELOCITY_REV}.json"
    return f"derived/{kind}.{ext}"


def velocity_rel(i: int) -> str:
    return f"derived/velocity.v{VELOCITY_REV}/{i:04d}.png"


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
    derive_velocity(run_id)


def derive_kind(run_id: str, kind: str) -> None:
    """Write one missing kind (velocity alone is cheap to add to runs whose maps already exist)."""
    if kind == "velocity":
        derive_velocity(run_id)
    else:
        derive(run_id)


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
    line. No "deepest cell" point: the deepest land cell tends to sit against a closed domain edge.

    Roads crossing a planned pond count as cut from t=0 in the engine (edges_cut), by design. Here they are a
    separate "pond_closure" event, and every flood event (first cut, jumps, per-place first cut) counts only
    roads cut by water, so a pond never reads as "first road impassable at T+00:00"."""
    from dryrun.sim import interventions

    m = storage.load_run(run_id)
    aoi_id = m.scenario.aoi_id
    g = storage.load_aoi(aoi_id).grid
    excl = _exclude(m)
    ponds = interventions.pond_mask(m.scenario, g, storage.load_raster(aoi_id, "exclude_mask") > 0.5)
    ea = exposure.edge_arrays(aoi_id)
    ts, depth = stack(run_id)
    by_pond = exposure.edges_touching(ea, ponds)
    cuts = np.array([exposure.cut_mask(aoi_id, d.astype(np.float32), excl, ponds) for d in depth]) & ~by_pond
    places = place_masks(aoi_id)
    on_place = {name: exposure.edges_touching(ea, mk) for name, _, mk in places}
    ends = np.append(ea.starts[1:], len(ea.flat))
    series = m.timeseries

    def newly_cut(j: int) -> np.ndarray:
        return cuts[j] & ~cuts[j - 1] if j else cuts[j]

    def cut_event(label: str, i: int, count: int, kind: str, new: np.ndarray | None = None) -> dict:
        if new is None:
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
    n_pond = int(by_pond.sum())
    if n_pond:
        closure = cut_event("roads closed by the planned pond", 0, n_pond, "pond_closure", new=by_pond)
        if closure:  # the same km the engine's road_km_impassable carries from t=0
            closure["road_km"] = round(exposure.road_km_cut(aoi_id, by_pond), 3)
        out.append(closure)
    cut_series = np.maximum(np.array(series.edges_cut) - n_pond, 0)  # engine count minus pond roads
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
            "events": out, "places": per, "events_rev": EVENTS_REV,
            "note": "times to the nearest frame; run-wide counts from the engine timeseries (minus roads closed by a "
                    "planned pond); per-place values and map points from the stored float16 frames; thresholds are "
                    "assumptions"}


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


# ------------------------------------------------------------------ velocity
VEL_BLOCK_M = 90.0  # target block size; the block is a whole number of model cells
VEL_WET_M = 0.05  # blocks shallower than this are transparent, as in the depth PNGs (alpha ramp starts at 5 cm)


def face_flux(h: np.ndarray, z: np.ndarray, n: np.ndarray, dx: float, dy: float):
    """Unit discharge (m2/s) on the solver's x and y faces from one depth frame, by the solver's own momentum
    equation at steady state (no inertia): q = -sign(S) hf^(5/3) sqrt(|S|) / n, the Manning flow down the
    water-surface slope S, with hf as in solver._numpy_step. Capped at Froude 1 (q <= hf sqrt(g hf)): the
    frames carry no inertia, so steep fronts would otherwise give unphysical speeds."""
    from dryrun.sim.solver import H_MIN, G

    eta = z + h
    out = []
    for el, er, zl, zr, nl, nr, d in ((eta[:, :-1], eta[:, 1:], z[:, :-1], z[:, 1:], n[:, :-1], n[:, 1:], dx),
                                      (eta[:-1, :], eta[1:, :], z[:-1, :], z[1:, :], n[:-1, :], n[1:, :], dy)):
        hf = np.maximum(el, er) - np.maximum(zl, zr)
        hs = np.where(hf > H_MIN, hf, 0.0)
        s = (er - el) / d
        q = -np.sign(s) * hs ** (5 / 3) * np.sqrt(np.abs(s)) / (0.5 * (nl + nr))
        cap = hs * np.sqrt(G * hs)
        out.append(np.clip(q, -cap, cap))
    return out


def velocity_frame(h, z, n, bnd, dx, dy, k):
    """(u east, v north, wet) on k x k blocks: block discharge over block depth, so shallow cells don't
    dominate. Held open-water boundary cells carry no flow and don't count."""
    from dryrun.sim.solver import G

    qx, qy = face_flux(h, z, n, dx, dy)
    ny, nx = h.shape
    qxc = np.zeros((ny, nx))
    qyc = np.zeros((ny, nx))
    qxc[:, 1:] += 0.5 * qx
    qxc[:, :-1] += 0.5 * qx
    qyc[1:, :] -= 0.5 * qy  # solver y faces are positive southward
    qyc[:-1, :] -= 0.5 * qy
    hw = np.where(bnd, 0.0, h)
    qxc[bnd] = 0.0
    qyc[bnd] = 0.0
    py, px = -ny % k, -nx % k

    def block(a):
        a = np.pad(a, ((0, py), (0, px)))
        return a.reshape(a.shape[0] // k, k, a.shape[1] // k, k).sum(axis=(1, 3))

    hs = block(hw)
    cells = block((~bnd).astype(np.float64))
    with np.errstate(invalid="ignore", divide="ignore"):
        u = np.where(hs > 0, block(qxc) / hs, 0.0)
        v = np.where(hs > 0, block(qyc) / hs, 0.0)
        hbar = hs / np.maximum(cells, 1)
        wet = (cells > 0) & (hbar >= VEL_WET_M)
        # Froude 1 on the block too: half of a deep face's flux lands in a shallow neighbour cell
        f = np.minimum(1.0, np.sqrt(G * hbar) / np.maximum(np.hypot(u, v), 1e-12))
    return u * f, v * f, wet


def velocity_png(u, v, wet, vmax: float) -> bytes:
    scale = vmax / 127
    rgba = np.zeros(u.shape + (4,), np.uint8)
    rgba[..., 0] = np.clip(np.round(u / scale) + 128, 1, 255)
    rgba[..., 1] = np.clip(np.round(v / scale) + 128, 1, 255)
    rgba[..., 2] = np.clip(np.round(np.hypot(u, v) / vmax * 255), 0, 255)
    rgba[..., 3] = np.where(wet, 255, 0)
    rgba[~wet, :3] = (128, 128, 0)
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "PNG", compress_level=6)
    return buf.getvalue()


def velocity(run_id: str):
    """(manifest, [(u, v, wet) per frame]) for a done run."""
    m = storage.load_run(run_id)
    inp = _inputs_for(m.run_id, m.scenario.model_dump_json())
    grid = storage.load_aoi(m.scenario.aoi_id).grid
    ts, depth = stack(run_id)
    z = np.asarray(inp.dem, np.float64)
    n = np.asarray(inp.manning, np.float64)
    bnd = (np.zeros(z.shape, bool) if inp.boundary_mask is None else np.asarray(inp.boundary_mask, bool))
    k = max(1, round(VEL_BLOCK_M / grid.dx_m))
    frames = [velocity_frame(d.astype(np.float64), z, n, bnd, grid.dx_m, grid.dy_m, k) for d in depth]
    speeds = np.concatenate([np.hypot(u, v)[w] for u, v, w in frames] or [np.zeros(1)])
    peak = float(speeds.max()) if speeds.size else 0.0
    vmax = max(0.5, float(np.ceil(np.percentile(speeds, 99.5) * 2) / 2)) if speeds.size else 0.5
    ny, nx = frames[0][0].shape
    w, s, e, nn = grid.bounds_wgs84
    manifest = {
        "kind": "velocity", "rev": VELOCITY_REV, "units": "m/s",
        "block_cells": k, "block_m": round(k * grid.dx_m, 1), "nx": nx, "ny": ny,
        # the last block row/column may extend past the AOI edge (padding); bounds are the padded extent
        "bounds_wgs84": [w, nn - ny * k / grid.ny * (nn - s), w + nx * k / grid.nx * (e - w), nn],
        "vmax_m_s": vmax, "scale_m_s": round(vmax / 127, 6), "peak_speed_m_s": round(peak, 2),
        "wet_threshold_m": VEL_WET_M,
        "encoding": {"r": "u (east) = (R - 128) * scale_m_s", "g": "v (north) = (G - 128) * scale_m_s",
                     "b": "speed = B / 255 * vmax_m_s (clipped at vmax)", "a": "255 = block depth >= wet_threshold_m",
                     "origin": "row 0 = north edge, column 0 = west edge"},
        "frames": [{"i": i, "t_s": float(t), "path": f"velocity/{i}"} for i, t in enumerate(ts)],
        "method": "estimated from each stored depth frame with the solver's friction law at steady state "
                  "(Manning flow down the water-surface slope), capped at Froude 1; not the solver's internal "
                  "fluxes. Good for flow direction and relative speed; speeds at fast-changing fronts are approximate.",
    }
    return manifest, frames


def derive_velocity(run_id: str) -> None:
    manifest, frames = velocity(run_id)
    vmax = manifest["vmax_m_s"]
    list(_IO.map(lambda iv: storage.write_run_file(run_id, velocity_rel(iv[0]), velocity_png(*iv[1], vmax), "image/png"),
                 enumerate(frames)))
    storage.write_run_file(run_id, rel("velocity", "json"), json.dumps(manifest).encode(), "application/json")


def exists(run_id: str, kind: str) -> bool:
    return storage._exists("runs", f"{run_id}/{rel(kind, 'json')}")
