"""Drain and sewer model coupled to the 2D surface solver, contract 0.8.0 (owner: Eng A).

Design and sources: docs/reports "Sewer and drain model design". Runs after every surface step (operator split),
moving water between the surface depth h and two kinds of storage:

OPEN channels (Lagos roadside drains, ditches, canals; drains inferred along roads), one node per grid cell:
  capture   lateral weir along the open banks Q = Cw_lat * L_open * d^1.5, plus grates on covered sections
            (HEC-22 sag inlet, below), times (1 - blockage); never more than the cell holds or the channel has room for
  routing   local-inertial (as the surface solver) along undirected links between neighbouring nodes:
            Q = (Q - g A dt dEta/L) / (1 + g dt n^2 |Q| / (A R^(4/3))), sub-stepped for the channel wave speed,
            with the momentum dropped when it opposes the level gradient (damps sloshing in low-friction canals);
            A is the channel section only (flow above the banks is the surface solver's); the level is that of
            the channel and the water on its cell taken together
  start     channels whose bed lies below the receiving water and that reach an outfall without a flap gate
            start filled to that level (tidal water, not counted as drained rain)
  outfalls  nodes beside open water: the receiving level is the tide (TideLevel) for outfall="tide", the bed for
            "free", no flow for "blocked"; flap gates stop inflow, and so does standing water on the node's cell
            (the receiving water reaches it over the street already: two paths would cycle water)
  overflow  a node over its bank volume spills the excess back onto its cell
CLOSED sewers (Queens), one lumped storage per zone (dryrun/pipeline/drains.py):
  capture   at inlet cells only, N grates x min(weir Cw*P*d^1.5, orifice Co*A*sqrt(2 g d)) x (1 - blockage), limited
            to the room left in the zone plus what its outfall passes during the step
  outflow   nonlinear reservoir Q = Qmax sqrt(H / Hd), H = hydraulic grade - receiving level, grade rising from the
            outfall invert (empty) to the zone's lowest inlet ground (full); Qmax = capacity x runoff coefficient x
            zone area; reverse flow (outside water in) only without flap gates
  surcharge a full zone keeps taking water at inlets standing SURCHARGE_HEAD_M or more above its lowest inlet (the
            pressurised pipes still carry up to Qmax from high ground) and pushes the excess out at its lowest
            inlet cells: full sewers move water from high streets to the low ones

Volumes: captured (into storage), surcharge (back onto the surface), outfall (net out through outfalls). The
surface loses captured - surcharge, which the engine reports as drained_volume_m3 = outfall + storage_end, so the
run's mass balance keeps its formula.
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass, field, replace
from functools import lru_cache

import numpy as np

from dryrun.contracts import DrainUpgrade, GridSpec, ScenarioSpec
from dryrun.contracts.schemas import AOIManifest, DrainageDefault

G = 9.81
H_MIN = 1e-3
CW_GRATE, CO_GRATE = 1.66, 0.67  # HEC-22 SI sag-inlet weir / orifice coefficients
GRATE_P_M, GRATE_A_M2 = 1.8, 0.18  # 0.6 x 0.6 m curb grate: weir perimeter, open area (assumed)
CW_LATERAL = 1.60  # curb-opening weir coefficient (SI) along an open drain edge
ALPHA_CH = 0.7
FULL_PCT = 95.0  # "full" for drain_full_t_s
SURCHARGE_WINDOW_FRACTION = 0.05
MODES = {"tide": 0, "free": 1, "blocked": 2}
SURCHARGE_HEAD_M = 1.0  # inlets this far above a zone's lowest inlet still drain into full pipes
SEWER_STORAGE_MM = 12.0
# R^(4/3) in the friction term, tabulated on t = sqrt(R) (pow() was half the kernel's time); exact beyond the table
R43_T_MAX, R43_N = 1.5, 4096
R43 = (np.linspace(0.0, R43_T_MAX, R43_N + 1) ** 2) ** (4.0 / 3.0)
R43_SCALE = R43_N / R43_T_MAX  # closed-sewer storage where the AOI has none (a what-if on an open-drain city)


@dataclass(frozen=True)
class Settings:
    system: str
    capacity_mm_h: float
    blockage: float  # 0-0.9
    outfall: str
    flap_gates: bool
    roadside_gutters: bool
    default: DrainageDefault

    @property
    def open(self) -> bool:
        return self.system in ("open", "mixed")

    @property
    def closed(self) -> bool:
        return self.system in ("closed", "mixed")


def settings(spec: ScenarioSpec, aoi: AOIManifest) -> Settings | None:
    """The drainage this run models, or None (constant drain_sink_mm_h). Raises ValueError for a Drainage on an AOI
    without drainage_default, or a return period the AOI has no design rate for."""
    d, dflt = spec.drainage, aoi.drainage_default
    if dflt is None:
        if d is not None:
            raise ValueError(f"{aoi.aoi_id} has no drain network: drainage needs an AOI published with one")
        return None
    if d is None:
        from dryrun.contracts.schemas import Drainage

        d = Drainage()
    system = d.system or dflt.system
    if d.capacity_mm_h is not None:
        cap = d.capacity_mm_h
    elif d.return_period_yr is not None:
        key = str(d.return_period_yr)
        if key not in dflt.design_mm_h_by_return_period:
            have = ", ".join(dflt.design_mm_h_by_return_period) or "none published"
            raise ValueError(f"no design rate for a {key}-year storm on {aoi.aoi_id} (available: {have})")
        cap = dflt.design_mm_h_by_return_period[key]
    else:
        cap = dflt.capacity_mm_h
    return Settings(system, float(cap), (dflt.blockage_pct if d.blockage_pct is None else d.blockage_pct) / 100.0,
                    d.outfall, dflt.flap_gates if d.flap_gates is None else d.flap_gates,
                    dflt.roadside_gutters if d.roadside_gutters is None else d.roadside_gutters, dflt)


def limits(s: Settings, has_channels: bool) -> list[str]:
    out = list(s.default.limits)
    if s.outfall == "blocked":
        out.append("Outfalls blocked: nothing leaves the drains, they only store and then overflow.")
    elif s.outfall == "free":
        out.append("Outfalls free: the receiving water level is ignored.")
    if s.open and not has_channels:
        out.append("No open drains are mapped here, so the open system carries nothing.")
    if s.closed and s.default.system == "open":
        out.append(f"Closed sewers are a what-if here: none exist, so they are sized at the {s.capacity_mm_h:g} mm/h "
                   "chosen, with inlets assumed every 50 m of road.")
    if s.blockage >= 0.5:
        out.append(f"{s.blockage * 100:.0f} % blockage: a heavily silted or littered system.")
    return out


@dataclass
class Drains:
    """Arrays the kernel reads and updates. Flat cell indices are into the solved domain (the rain window, if any)."""

    s: Settings
    # channels
    n_cell: np.ndarray
    n_zb: np.ndarray  # bed elevation (m)
    n_w: np.ndarray  # effective width (m), blockage included
    n_L: np.ndarray
    n_vmax: np.ndarray
    n_n: np.ndarray
    n_weir: np.ndarray  # effective lateral weir length (m)
    n_grates: np.ndarray  # effective grates (covered sections)
    n_out: np.ndarray  # indices of the outfall nodes
    l_a: np.ndarray
    l_b: np.ndarray
    l_len: np.ndarray
    # zones
    z_qmax: np.ndarray  # m3/s
    z_vmax: np.ndarray
    z_inv: np.ndarray
    z_low: np.ndarray
    z_gated: np.ndarray
    z_in_ptr: np.ndarray  # CSR over inlet cells
    z_in_cell: np.ndarray
    z_in_n: np.ndarray  # grates per inlet cell (effective)
    z_in_high: np.ndarray  # 1 = inlet SURCHARGE_HEAD_M or more above the zone's lowest inlet
    z_sc_ptr: np.ndarray  # CSR over surcharge cells
    z_sc_cell: np.ndarray
    # drain_fill
    fill_ids: list[str]
    fill_kind: list[str]
    f_ptr: np.ndarray  # CSR over channel nodes per line feature (zones follow, one each)
    f_node: np.ndarray
    # state
    n_v: np.ndarray = field(default=None)
    l_q: np.ndarray = field(default=None)
    o_q: np.ndarray = field(default=None)
    z_v: np.ndarray = field(default=None)
    changed_cells: int = 0
    # derived kernel inputs (__post_init__)
    n_plan: np.ndarray = field(default=None)
    n_dep: np.ndarray = field(default=None)
    l_wf: np.ndarray = field(default=None)
    l_n2: np.ndarray = field(default=None)
    l_dep: np.ndarray = field(default=None)

    def __post_init__(self):
        self.n_plan = self.n_w * self.n_L
        self.n_dep = self.n_vmax / np.where(self.n_plan > 0, self.n_plan, 1.0)
        self.l_wf = np.minimum(self.n_w[self.l_a], self.n_w[self.l_b])
        self.l_n2 = (0.5 * (self.n_n[self.l_a] + self.n_n[self.l_b])) ** 2
        self.l_dep = np.minimum(self.n_dep[self.l_a], self.n_dep[self.l_b])
        self.reset()

    def reset(self):
        self.n_v = np.zeros(len(self.n_cell))
        self.l_q = np.zeros(len(self.l_a))
        self.o_q = np.zeros(len(self.n_cell))
        self.z_v = np.zeros(len(self.z_qmax))

    @property
    def has_channels(self) -> bool:
        return len(self.n_cell) > 0

    def capacity_m3(self) -> float:
        return float(self.n_vmax.sum() + self.z_vmax.sum())

    def stored_m3(self) -> float:
        return float(self.n_v.sum() + self.z_v.sum())

    def fill_pct(self) -> list[int]:
        """Per drain_fill id, 0-100: channel lines volume-weighted over their nodes, zones directly."""
        out = []
        for k in range(len(self.f_ptr) - 1):
            nodes = self.f_node[self.f_ptr[k]:self.f_ptr[k + 1]]
            cap = self.n_vmax[nodes].sum()
            out.append(int(round(100 * self.n_v[nodes].sum() / cap)) if cap > 0 else 0)
        for v, vm in zip(self.z_v, self.z_vmax):
            out.append(int(round(100 * v / vm)) if vm > 0 else 0)
        return out


def build(s: Settings, doc: dict, inlets: np.ndarray, zones: np.ndarray, dem: np.ndarray, grid: GridSpec,
          spec: ScenarioSpec, cell_map: np.ndarray | None = None, domain_bnd: np.ndarray | None = None) -> Drains:
    """Assemble kernel arrays from the AOI's drain_network document and rasters (full AOI grid).

    cell_map: full flat index -> domain flat index (-1 = outside the solved window); None = whole grid.
    domain_bnd: bool mask of held boundary cells in the domain (a window's edge ring included): channel nodes on
    them are dropped and their neighbours become outfalls; inlet cells on them are dropped.
    """
    from dryrun.sim.interventions import area_mask

    ncell = grid.nx * grid.ny
    cmap = np.arange(ncell) if cell_map is None else np.asarray(cell_map)
    dbnd = None if domain_bnd is None else np.asarray(domain_bnd, bool).reshape(-1)
    area = grid.dx_m * grid.dy_m
    dem_f = np.asarray(dem, np.float64).reshape(-1)

    # DrainUpgrade(capacity_factor) masks on the full grid
    factor = np.ones(ncell)
    upgraded = np.zeros(ncell, bool)
    for iv in spec.interventions:
        if isinstance(iv, DrainUpgrade) and iv.capacity_factor != 1.0:
            m = area_mask(spec, grid, iv, default_all=True).reshape(-1)
            factor[m] *= iv.capacity_factor
            upgraded |= m

    # ---- channels
    nd = doc["nodes"]
    cells = np.asarray(nd["cell"], np.int64)
    keep = np.ones(len(cells), bool)
    if not s.open:
        keep[:] = False
    elif not s.roadside_gutters:
        keep &= np.asarray(nd["channel"]) != "gutter"
    dom = cmap[cells]
    keep &= dom >= 0
    keep &= factor[cells] > 0  # DrainUpgrade(capacity_factor=0) removes the drains there
    default_open = s.default.system == "open"
    wscale = 1.0
    if s.system == "open" and default_open and s.default.capacity_mm_h > 0:  # capacity sizes the channels
        wscale = s.capacity_mm_h / s.default.capacity_mm_h
    if wscale <= 0:
        keep[:] = False  # zero capacity: no channels at all
    on_bnd = np.zeros(len(cells), bool)
    if dbnd is not None:
        on_bnd = keep & dbnd[np.where(dom >= 0, dom, 0)]
    la, lb = np.asarray(doc["links"]["a"], np.int64), np.asarray(doc["links"]["b"], np.int64)
    out = np.zeros(len(cells), bool)
    out[np.asarray(doc["outfalls"]["node"], np.int64)] = True
    # nodes dropped on a window's held edge: their kept neighbours discharge there instead
    edge_nb = (on_bnd[la] & keep[lb] & ~on_bnd[lb], on_bnd[lb] & keep[la] & ~on_bnd[la])
    out[lb[edge_nb[0]]] = True
    out[la[edge_nb[1]]] = True
    keep &= ~on_bnd
    idx = np.full(len(cells), -1, np.int64)
    idx[keep] = np.arange(int(keep.sum()))
    lk = keep[la] & keep[lb]

    fac = factor[cells[keep]]
    width = np.asarray(nd["width_m"], np.float64)[keep] * wscale * fac * (1 - s.blockage)
    depth = np.asarray(nd["depth_m"], np.float64)[keep]
    L = np.asarray(nd["length_m"], np.float64)[keep]
    n_cell = dom[keep]

    # ---- zones
    nz = len(doc["zones"])
    zq, zv, zinv, zlow, zgate = (np.zeros(nz) for _ in range(5))
    in_ptr, in_cell, in_n, in_high, sc_ptr, sc_cell = [0], [], [], [], [0], []
    zfull = np.asarray(zones, np.int64).reshape(-1)
    inl = np.asarray(inlets, np.float64).reshape(-1)
    zkeep = np.zeros(nz, bool)
    if s.closed:
        land_dom = cmap >= 0
        if dbnd is not None:
            land_dom &= ~dbnd[np.where(cmap >= 0, cmap, 0)]
        rate = s.capacity_mm_h * s.default.runoff_coefficient / 3.6e6  # m/s per m2 of zone
        storage = (s.default.storage_mm if s.default.storage_mm > 0 else SEWER_STORAGE_MM) / 1000.0
        order = np.argsort(zfull, kind="stable")
        bounds = np.searchsorted(zfull[order], np.arange(nz + 1))
        for k, z in enumerate(doc["zones"]):
            zc = order[bounds[k]:bounds[k + 1]]
            zc = zc[land_dom[zc]]
            ic = zc[(inl[zc] > 0) & (factor[zc] > 0)]  # inlets of removed sewers (factor 0) take nothing
            if len(ic) == 0:
                in_ptr.append(len(in_cell))
                sc_ptr.append(len(sc_cell))
                continue
            zkeep[k] = True
            zq[k] = rate * area * float(factor[zc].sum())
            zv[k] = storage * area * float(factor[zc].sum())
            zinv[k] = z["invert_m"]
            ground = dem_f[ic]
            zlow[k] = max(float(np.quantile(ground, 0.05)), z["invert_m"] + 0.5)
            zgate[k] = 1.0 if s.flap_gates else 0.0
            in_cell += cmap[ic].tolist()
            in_n += (inl[ic] * (1 - s.blockage)).tolist()
            in_high += (ground >= zlow[k] + SURCHARGE_HEAD_M).astype(np.int64).tolist()
            in_ptr.append(len(in_cell))
            low = ic[ground <= np.quantile(ground, 0.10)]
            sc_cell += cmap[low].tolist()
            sc_ptr.append(len(sc_cell))

    # ---- drain_fill ids: line features with kept nodes, then zones
    f_ids, f_kind, f_ptr, f_node = [], [], [0], []
    for f in doc["features"]:
        nodes = idx[np.asarray(f["nodes"], np.int64)]
        nodes = nodes[nodes >= 0]
        if len(nodes):
            f_ids.append(f["id"])
            f_kind.append(f["kind"])
            f_node += nodes.tolist()
            f_ptr.append(len(f_node))
    zk = np.flatnonzero(zkeep)
    f_ids += [f"zone:{doc['zones'][k]['id']}" for k in zk]
    f_kind += ["sewer_zone"] * len(zk)

    def zsel(a):
        return np.asarray(a, np.float64)[zk]

    in_ptr, sc_ptr = np.asarray(in_ptr, np.int64), np.asarray(sc_ptr, np.int64)
    new_in_ptr, new_sc_ptr = [0], [0]
    for k in zk:
        new_in_ptr.append(new_in_ptr[-1] + int(in_ptr[k + 1] - in_ptr[k]))
        new_sc_ptr.append(new_sc_ptr[-1] + int(sc_ptr[k + 1] - sc_ptr[k]))
    in_take = np.concatenate([np.arange(in_ptr[k], in_ptr[k + 1]) for k in zk]) if len(zk) else np.zeros(0, int)
    sc_take = np.concatenate([np.arange(sc_ptr[k], sc_ptr[k + 1]) for k in zk]) if len(zk) else np.zeros(0, int)

    changed = int(upgraded[cells[keep]].sum())
    if s.closed:
        changed += int((upgraded & (zfull >= 0) & (inl > 0)).sum())
    return Drains(
        s=s, n_cell=n_cell, n_zb=dem_f[cells[keep]] - depth, n_w=width, n_L=L, n_vmax=width * depth * L,
        n_n=np.asarray(nd["manning"], np.float64)[keep],
        n_weir=np.asarray(nd["weir_m"], np.float64)[keep] * fac * (1 - s.blockage),
        n_grates=np.asarray(nd["inlets"], np.float64)[keep] * fac * (1 - s.blockage),
        n_out=np.flatnonzero(out[keep]).astype(np.int64), l_a=idx[la[lk]], l_b=idx[lb[lk]],
        l_len=np.asarray(doc["links"]["length_m"], np.float64)[lk],
        z_qmax=zsel(zq), z_vmax=zsel(zv), z_inv=zsel(zinv), z_low=zsel(zlow), z_gated=zsel(zgate),
        z_in_ptr=np.asarray(new_in_ptr, np.int64), z_in_cell=np.asarray(in_cell, np.int64)[in_take],
        z_in_n=np.asarray(in_n, np.float64)[in_take], z_in_high=np.asarray(in_high, np.int64)[in_take], z_sc_ptr=np.asarray(new_sc_ptr, np.int64),
        z_sc_cell=np.asarray(sc_cell, np.int64)[sc_take], fill_ids=f_ids, fill_kind=f_kind,
        f_ptr=np.asarray(f_ptr, np.int64), f_node=np.asarray(f_node, np.int64), changed_cells=changed)


def load(spec: ScenarioSpec, aoi: AOIManifest, dem: np.ndarray) -> Drains | None:
    """Drains for a run on the whole AOI grid (engine), or None for the constant-sink model."""
    from dryrun import storage

    s = settings(spec, aoi)
    if s is None:
        return None
    doc = json.loads(storage.load_aoi_file(aoi.aoi_id, "drain_network"))
    return build(s, doc, storage.load_raster(aoi.aoi_id, "inlets_count"),
                 storage.load_raster(aoi.aoi_id, "sewer_zones"), dem, aoi.grid, spec)


def crop(dr: Drains, spec: ScenarioSpec, aoi: AOIManifest, dem: np.ndarray, win: tuple[slice, slice],
         domain_bnd: np.ndarray) -> Drains:
    """The same drains restricted to a rain window (reloads the network; zones keep only their part inside)."""
    from dryrun import storage

    g = aoi.grid
    r, c = win
    cmap = np.full((g.ny, g.nx), -1, np.int64)
    w = c.stop - c.start
    rr, cc = np.mgrid[r, c]
    cmap[r, c] = (rr - r.start) * w + (cc - c.start)
    doc = json.loads(storage.load_aoi_file(aoi.aoi_id, "drain_network"))
    return build(dr.s, doc, storage.load_raster(aoi.aoi_id, "inlets_count"),
                 storage.load_raster(aoi.aoi_id, "sewer_zones"), dem, g, spec, cmap.reshape(-1), domain_bnd)


# ------------------------------------------------------------------------------------------ kernel
def _step_loops(h, area, dt, tide, mode, gated_ch,
                n_cell, n_zb, n_plan, n_dep, n_w, n_L, n_vmax, n_n, n_weir, n_grates, n_out, n_v, o_q,
                l_a, l_b, l_len, l_wf, l_n2, l_dep, l_q, z_qmax, z_vmax, z_inv, z_low, z_gated, z_v,
                z_in_ptr, z_in_cell, z_in_n, z_in_high, z_sc_ptr, z_sc_cell, dt_ch, work, eta_n, r43t):
    """One drainage step on the flat surface depth h. Returns (captured, surcharge, outfall) in m3.
    n_plan = width x length, n_dep = bank depth; per link l_wf = narrower width, l_n2 = mean n squared,
    l_dep = shallower bank depth."""
    captured = 0.0
    surcharge = 0.0
    outfall = 0.0
    nn = n_cell.shape[0]
    nl = l_a.shape[0]
    # ---------------- open channels: capture
    for i in range(nn):
        c = n_cell[i]
        d = h[c]
        if d > H_MIN:
            room = n_vmax[i] - n_v[i]
            if room > 0.0:
                d15 = d * math.sqrt(d)
                q = CW_LATERAL * n_weir[i] * d15
                if n_grates[i] > 0.0:
                    q += n_grates[i] * min(CW_GRATE * GRATE_P_M * d15, CO_GRATE * GRATE_A_M2 * math.sqrt(2 * G * d))
                v = min(q * dt, d * area, room)
                n_v[i] += v
                h[c] -= v / area
                captured += v
    # ---------------- open channels: routing (sub-steps)
    if nn > 0:
        nsub = max(1, int(math.ceil(dt / dt_ch)))
        ds = dt / nsub
        for _ in range(nsub):
            # water level of the channel and the water standing on its cell taken together (capture moves water
            # between the two within a step; a head from the channel alone would flip as capture empties the
            # street, pulling in the receiving water)
            for i in range(nn):
                tot = n_v[i] + h[n_cell[i]] * area
                if tot <= n_vmax[i]:
                    eta_n[i] = n_zb[i] + tot / n_plan[i]
                else:
                    eta_n[i] = n_zb[i] + n_dep[i] + (tot - n_vmax[i]) / area
                work[i] = 0.0
            # local-inertial link fluxes through the channel section; work = volume each node would send
            for k in range(nl):
                a = l_a[k]
                b = l_b[k]
                ea = eta_n[a]
                eb = eta_n[b]
                hf = min(max(ea, eb) - max(n_zb[a], n_zb[b]), l_dep[k])
                if hf > H_MIN:
                    wf = l_wf[k]
                    af = wf * hf
                    rh = af / (wf + 2 * hf)
                    q = l_q[k]
                    if q * (eb - ea) > 0.0:  # momentum against the level gradient: drop it (no sloshing)
                        q = 0.0
                    x = math.sqrt(rh) * R43_SCALE  # R^(4/3) from the table
                    ix = int(x)
                    r43 = r43t[ix] + (x - ix) * (r43t[ix + 1] - r43t[ix]) if ix < R43_N else rh ** (4.0 / 3.0)
                    q = (q - G * af * ds * (eb - ea) / l_len[k]) / (1 + G * ds * l_n2[k] * abs(q) / (af * r43))
                    l_q[k] = q
                    if q > 0:
                        work[a] += q * ds
                    else:
                        work[b] -= q * ds
                else:
                    l_q[k] = 0.0
            # outfalls (positive = out of the network); n_out lists the outfall nodes
            for j in range(n_out.shape[0]):
                i = n_out[j]
                q = o_q[i]
                o_q[i] = 0.0
                if mode == 2:
                    continue
                y = n_v[i] / n_plan[i]
                eta = eta_n[i]
                tw = n_zb[i] if mode == 1 else max(tide, n_zb[i])
                hf = min(max(eta, tw) - n_zb[i], n_dep[i])
                if hf <= H_MIN or (gated_ch and tw >= eta):
                    continue
                wf = n_w[i]
                af = wf * hf
                rh = af / (wf + 2 * hf)
                if q * (tw - eta) > 0.0:
                    q = 0.0
                # node centre to the open-water cell beside it: the node's length
                x = math.sqrt(rh) * R43_SCALE
                ix = int(x)
                r43 = r43t[ix] + (x - ix) * (r43t[ix + 1] - r43t[ix]) if ix < R43_N else rh ** (4.0 / 3.0)
                q = (q - G * af * ds * (tw - eta) / n_L[i]) / (1 + G * ds * n_n[i] * n_n[i] * abs(q) / (af * r43))
                qc = wf * math.sqrt(G * max(y, 0.0)) * max(y, 0.0)  # at most critical flow over the mouth
                if q > qc:
                    q = qc
                if q < 0.0 and (gated_ch or h[n_cell[i]] > H_MIN):
                    q = 0.0  # flap gate; or the receiving water already reaches this wet cell over the street
                o_q[i] = q
                if q > 0:
                    work[i] += q * ds
            # positivity: a node never sends more than it holds
            for i in range(nn):
                w_ = work[i]
                work[i] = max(n_v[i], 0.0) / w_ if w_ > n_v[i] and w_ > 0.0 else 1.0
            for k in range(nl):
                q = l_q[k]
                if q != 0.0:
                    q = q * work[l_a[k]] if q > 0 else q * work[l_b[k]]
                    l_q[k] = q
                    v = q * ds
                    n_v[l_a[k]] -= v
                    n_v[l_b[k]] += v
            for j in range(n_out.shape[0]):
                i = n_out[j]
                q = o_q[i]
                if q > 0:
                    q *= work[i]
                    o_q[i] = q
                v = q * ds
                n_v[i] = max(n_v[i] - v, 0.0)
                outfall += v
        # overflow back onto the street
        for i in range(nn):
            if n_v[i] > n_vmax[i]:
                ex = n_v[i] - n_vmax[i]
                n_v[i] = n_vmax[i]
                h[n_cell[i]] += ex / area
                surcharge += ex
    # ---------------- closed sewer zones
    for z in range(z_qmax.shape[0]):
        vm = z_vmax[z]
        hd = z_low[z] - z_inv[z]
        # inlets take what the pipes have room for, plus what the outfall could pass during the step once the
        # storage fills (grade at the lowest inlet)
        qpass = 0.0
        if mode != 2:
            head_full = z_low[z] - (z_inv[z] if mode == 1 else max(tide, z_inv[z]))
            if head_full > 0:
                qpass = z_qmax[z] * math.sqrt(min(head_full / hd, 1.0))
        room = max(vm - z_v[z] + qpass * dt, 0.0)
        dem_lo = 0.0
        dem_hi = 0.0
        for p in range(z_in_ptr[z], z_in_ptr[z + 1]):
            d = h[z_in_cell[p]]
            if d > H_MIN:
                q = z_in_n[p] * min(CW_GRATE * GRATE_P_M * d ** 1.5, CO_GRATE * GRATE_A_M2 * math.sqrt(2 * G * d))
                if z_in_high[p] == 1:
                    dem_hi += min(q * dt, d * area)
                else:
                    dem_lo += min(q * dt, d * area)
        # low inlets share the room; high ones get what is left plus a pressurised pipe flow (surcharges below)
        s_lo = 1.0 if dem_lo <= room else room / dem_lo
        left = max(room - s_lo * dem_lo, 0.0) + z_qmax[z] * dt
        s_hi = 1.0 if dem_hi <= left else left / dem_hi
        if dem_lo + dem_hi > 0:
            for p in range(z_in_ptr[z], z_in_ptr[z + 1]):
                c = z_in_cell[p]
                d = h[c]
                if d > H_MIN:
                    q = z_in_n[p] * min(CW_GRATE * GRATE_P_M * d ** 1.5, CO_GRATE * GRATE_A_M2 * math.sqrt(2 * G * d))
                    v = min(q * dt, d * area) * (s_hi if z_in_high[p] == 1 else s_lo)
                    h[c] -= v / area
                    z_v[z] += v
                    captured += v
        # outfall, re-evaluated on the filled storage
        if mode != 2:
            grade = z_inv[z] + min(z_v[z] / vm, 1.0) * hd
            outside = z_inv[z] if mode == 1 else max(tide, z_inv[z])
            head = grade - outside
            q = 0.0
            if head > 0:
                q = z_qmax[z] * math.sqrt(min(head / hd, 1.0))
            elif head < 0 and z_gated[z] == 0.0:
                q = -z_qmax[z] * math.sqrt(min(-head / hd, 1.0))
            v = q * dt
            if v > z_v[z]:
                v = z_v[z]
            z_v[z] -= v
            outfall += v
        # surcharge at the lowest inlets
        if z_v[z] > vm:
            ex = z_v[z] - vm
            z_v[z] = vm
            ns = z_sc_ptr[z + 1] - z_sc_ptr[z]
            for p in range(z_sc_ptr[z], z_sc_ptr[z + 1]):
                h[z_sc_cell[p]] += ex / (ns * area)
            surcharge += ex
    return captured, surcharge, outfall


@lru_cache(maxsize=1)
def _kernel():
    kernel = os.getenv("DRYRUN_SOLVER_KERNEL", "auto")
    if kernel != "numpy":
        try:
            import numba
        except ImportError:
            numba = None
        if numba is not None:
            try:
                return numba.njit(cache=True, nogil=True)(_step_loops)
            except RuntimeError as exc:
                if "cannot cache" not in str(exc):
                    raise
                return numba.njit(nogil=True)(_step_loops)
    return _step_loops  # plain Python: correct but slow (laptops without numba)


class Runner:
    """Holds a Drains and its ledger while the solver steps."""

    def __init__(self, dr: Drains, cell_m: float, tide: float = -0.5):
        self.dr = dr
        self.start_m3 = prefill(dr, tide)
        # channel wave-speed limit: deepest bank-full channel, shortest link or outfall reach
        dmax = float(dr.n_dep.max()) if dr.has_channels else 1.0
        lmin = min([cell_m] + ([float(dr.l_len.min())] if len(dr.l_len) else [])
                   + ([float(dr.n_L[dr.n_out].min())] if len(dr.n_out) else []))
        self.dt_ch = ALPHA_CH * lmin / math.sqrt(G * max(dmax, 0.1))
        self.work = np.zeros(max(len(dr.n_cell), 1))
        self.eta = np.zeros(max(len(dr.n_cell), 1))
        self.k = _kernel()
        self.mode = MODES[dr.s.outfall]
        self.captured = self.surcharge = self.outfall = 0.0
        self.peak_pct = 0.0
        self.full_t = None
        self.t_frames: list[float] = []
        self.cap = max(dr.capacity_m3(), 1e-9)
        # per-frame series (filled by frame())
        self.fill: list[list[int]] = []
        self.full_pct: list[float] = []
        self.out_rate: list[float] = []
        self.sc_rate: list[float] = []
        self._frame_out = self._frame_sc = 0.0
        self._frame_t = 0.0

    def step(self, h2d: np.ndarray, area: float, dt: float, t: float, tide: float) -> tuple[float, float]:
        """Advance; returns (net volume taken off the surface, volume put back by overflow), m3."""
        dr = self.dr
        h = h2d.reshape(-1)
        cap, sc, out = self.k(h, area, dt, tide, self.mode, dr.s.flap_gates,
                              dr.n_cell, dr.n_zb, dr.n_plan, dr.n_dep, dr.n_w, dr.n_L, dr.n_vmax, dr.n_n, dr.n_weir,
                              dr.n_grates, dr.n_out, dr.n_v, dr.o_q, dr.l_a, dr.l_b, dr.l_len, dr.l_wf, dr.l_n2,
                              dr.l_dep, dr.l_q, dr.z_qmax, dr.z_vmax,
                              dr.z_inv, dr.z_low, dr.z_gated, dr.z_v, dr.z_in_ptr, dr.z_in_cell, dr.z_in_n, dr.z_in_high,
                              dr.z_sc_ptr, dr.z_sc_cell, self.dt_ch, self.work, self.eta, R43)
        self.captured += cap
        self.surcharge += sc
        self.outfall += out
        self._frame_out += out
        self._frame_sc += sc
        pct = self._pct()
        self.peak_pct = max(self.peak_pct, pct)
        if self.full_t is None and pct >= FULL_PCT:
            self.full_t = t + dt
        return cap - sc, sc

    def _pct(self) -> float:
        """System fill by rain water: storage gained since the start over the room there was at the start."""
        room = self.cap - self.start_m3
        return 100 * max(self.dr.stored_m3() - self.start_m3, 0.0) / room if room > 0 else 100.0

    def frame(self, t: float) -> None:
        span = t - self._frame_t
        self.t_frames.append(t)
        self.fill.append(self.dr.fill_pct())
        self.full_pct.append(round(self._pct(), 2))
        self.out_rate.append(round(self._frame_out / span, 3) if span > 0 else 0.0)
        self.sc_rate.append(round(self._frame_sc / span, 3) if span > 0 else 0.0)
        self._frame_out = self._frame_sc = 0.0
        self._frame_t = t

    def _window(self) -> tuple[int | None, int | None]:
        """Overflow window: first and last frame whose overflow rate is >= SURCHARGE_WINDOW_FRACTION of the peak
        (ignores the small start-up exchange where tidal channels meet wet banks)."""
        peak = max(self.sc_rate, default=0.0)
        if peak <= 0:
            return None, None
        hit = [t for t, r in zip(self.t_frames, self.sc_rate) if r >= SURCHARGE_WINDOW_FRACTION * peak]
        return int(hit[0]), int(hit[-1])

    def results(self) -> dict:
        sc0, sc1 = self._window()
        return {
            "stats": dict(sewer_captured_m3=round(self.captured, 1), sewer_surcharge_m3=round(self.surcharge, 1),
                          drain_outfall_m3=round(self.outfall, 1),
                          drain_storage_end_m3=round(self.dr.stored_m3() - self.start_m3, 1),
                          drain_peak_full_pct=round(self.peak_pct, 1),
                          drain_full_t_s=None if self.full_t is None else int(round(self.full_t)),
                          drain_surcharge_start_t_s=sc0, drain_surcharge_end_t_s=sc1),
            "series": dict(drain_full_pct=self.full_pct, drain_outfall_m3_s=self.out_rate,
                           surcharge_m3_s=self.sc_rate),
            "fill": dict(ids=self.dr.fill_ids, kind=self.dr.fill_kind, fill_pct=self.fill),
            "limits": limits(self.dr.s, self.dr.has_channels),
        }


def prefill(dr: Drains, tide: float) -> float:
    """Fill the tidal part of the channels to the receiving level (outfall="tide", no flap gates): nodes whose bed
    is below it and that connect to an outfall through such nodes. Returns the volume put in (m3)."""
    if not dr.has_channels or dr.s.outfall != "tide" or dr.s.flap_gates:
        return 0.0
    low = dr.n_zb < tide
    seen = np.zeros(len(dr.n_cell), bool)
    stack = [int(i) for i in dr.n_out if low[i]]
    seen[stack] = True
    nbrs: dict[int, list[int]] = {}
    for a, b in zip(dr.l_a.tolist(), dr.l_b.tolist()):
        nbrs.setdefault(a, []).append(b)
        nbrs.setdefault(b, []).append(a)
    while stack:
        i = stack.pop()
        for j in nbrs.get(i, ()):
            if low[j] and not seen[j]:
                seen[j] = True
                stack.append(j)
    dep = dr.n_vmax / (dr.n_w * dr.n_L)
    y = np.clip(tide - dr.n_zb, 0.0, dep)
    dr.n_v[seen] = (y * dr.n_w * dr.n_L)[seen]
    return float(dr.n_v.sum())


def warmup() -> None:
    """Compile the kernel (Docker build), like solver.warmup()."""
    s = Settings("mixed", 38.0, 0.1, "tide", True, True,
                 DrainageDefault(system="mixed", label="w", capacity_mm_h=38.0, blockage_pct=10,
                                 blockage_range_pct=(0, 50), flap_gates=True, roadside_gutters=True, receiving="w",
                                 storage_mm=12, limits=[]))
    i64 = np.array([0, 1], np.int64)
    f2 = np.ones(2)
    dr = Drains(s, i64, f2 * -1, f2, f2 * 30, f2 * 30, f2 * 0.015, f2 * 60, f2 * 0, np.array([1], np.int64),
                np.array([0], np.int64), np.array([1], np.int64), np.array([30.0]), np.array([1.0]), np.array([10.0]),
                np.array([0.0]), np.array([2.0]), np.array([1.0]), np.array([0, 1], np.int64),
                np.array([2], np.int64), np.array([1.0]), np.array([1], np.int64), np.array([0, 1], np.int64),
                np.array([2], np.int64), [], [], np.array([0], np.int64), np.zeros(0, np.int64))
    Runner(dr, 30.0).step(np.full((2, 2), 0.05), 900.0, 5.0, 0.0, -0.5)


def with_settings(dr: Drains, **kw) -> Drains:
    """A copy with new Settings fields (tests)."""
    return replace(dr, s=replace(dr.s, **kw))
