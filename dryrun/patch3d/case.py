"""Write an OpenFOAM interFoam case for a patch (owner: Eng A).

Mesh: one hex block (nx x ny x nz), then the solid cells (ground, buildings) are cut out with subsetMesh, so
terrain and walls are stair-stepped at cell_m horizontally and cell_m / 8 vertically. Every exposed solid face
lands in the `walls` patch (no-slip). The top is open atmosphere.

Sides (one-way nesting in the 2D run): every side holds the 2D water level over time as hydrostatic p_rgh
(timeVaryingMappedFixedValue); velocity follows from the pressure (pressureInletOutletVelocity); the water
fraction is inletOutlet (the 2D window-mean fraction where flow enters, the cell's own where it leaves), which
keeps alpha bounded. A fixed 2D fraction on faces where water leaves pushed out water the cells did not hold
(alpha fell to -83 and the solve failed). The side pressure can act on air in the interface band and in
corners; fvOptions limitVelocity caps cell speed at U_CAP_M_S, well above flood speeds, so those air currents
cannot run away. We do not impose the 2D velocity: it is estimated from the 2D water-surface slope, not a solved
flux, and imposing it added water the other sides could not shed (the box gained 120 % in 10 min). hRef sits at
the median 2D surface (reference_level).
Turbulence: k-omega SST with rough-wall functions (Ks from a bare urban-surface Manning n). A laminar model had
almost no bed resistance: water ran down the 2D surface slope at the 5 m/s cap and the box sloshed (volume
-20 % to +52 % of the 2D run). Wall functions at 0.25-2 m cells are coarse; near-wall detail is indicative.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np

from dryrun.patch3d.geometry import Patch

HEADER = """FoamFile
{{
    version 2.0;
    format ascii;
    class {cls};
    object {obj};
}}
"""
SIDES = ("south", "north", "west", "east")
G = 9.81
RHO_WATER, RHO_AIR = 1000.0, 1.0
BC_DT_S = 30.0  # boundary data sample interval
WRITE_DT_S = 30.0  # output frame interval
# Bed roughness. The 2D run's built-up Manning n (0.05) includes building drag, which the 3D mesh resolves, so the
# ground takes the bare urban-surface value; Strickler: n = ks^(1/6) / (8.1 sqrt(g)) -> ks = (25.4 n)^6.
GROUND_MANNING = 0.02
KS_GROUND_M = round((25.4 * GROUND_MANNING) ** 6, 4)  # ~0.017 m
K_IN, OMEGA_IN = 1e-4, 1.0  # small free-stream turbulence on inflow
U_CAP_M_S = 5.0  # cell speed cap (fvOptions limitVelocity): flood water here is < 2 m/s; this only stops the
# spurious air currents that the side pressure drives in the interface band and in corners


def _w(path: Path, cls: str, obj: str, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(HEADER.format(cls=cls, obj=obj) + body)


class Forcing:
    """Water surface elevation and depth-averaged velocity from the parent 2D run, bilinear in space and linear in
    time between its frames."""

    def __init__(self, run_id: str):
        from dryrun import derived, storage

        m = storage.load_run(run_id)
        self.aoi = storage.load_aoi(m.scenario.aoi_id)
        g = self.aoi.grid
        inp = derived._inputs_for(m.run_id, m.scenario.model_dump_json())
        self.ts, depth = derived.stack(run_id)
        self.dem = np.asarray(inp.dem, np.float64)
        n = np.asarray(inp.manning, np.float64)
        bnd = np.zeros(self.dem.shape, bool) if inp.boundary_mask is None else np.asarray(inp.boundary_mask, bool)
        self.depth = depth
        self._uv = {}
        self._args = (self.dem, n, bnd, g.dx_m, g.dy_m)

    def _frame_uv(self, i: int):
        if i not in self._uv:
            from dryrun import derived

            u, v, _ = derived.velocity_frame(self.depth[i].astype(np.float64), *self._args, 1)
            self._uv[i] = (u, v)
        return self._uv[i]

    def _bracket(self, t: float):
        i = int(np.clip(np.searchsorted(self.ts, t) - 1, 0, len(self.ts) - 2))
        a = float(np.clip((t - self.ts[i]) / max(self.ts[i + 1] - self.ts[i], 1e-9), 0, 1))
        return i, a

    def sample(self, lon: np.ndarray, lat: np.ndarray, t: float):
        """(wse, u, v) at points: wse = ground + depth of the 2D run (nan-free)."""
        from dryrun.patch3d.geometry import bilinear

        b = self.aoi.grid.bounds_wgs84
        i, a = self._bracket(t)
        d = (1 - a) * self.depth[i].astype(np.float64) + a * self.depth[i + 1].astype(np.float64)
        (u0, v0), (u1, v1) = self._frame_uv(i), self._frame_uv(i + 1)
        wse = bilinear(self.dem + d, b, lon, lat)
        return wse, bilinear((1 - a) * u0 + a * u1, b, lon, lat), bilinear((1 - a) * v0 + a * v1, b, lon, lat)

    def peak_time(self, lon: float, lat: float) -> float:
        from dryrun.patch3d.geometry import bilinear

        b = self.aoi.grid.bounds_wgs84
        d = [float(bilinear(f.astype(np.float64), b, np.array([lon]), np.array([lat]))[0]) for f in self.depth]
        return float(self.ts[int(np.argmax(d))])


def write_case(case: Path, p: Patch, forcing: Forcing, t0: float, t1: float, procs: int) -> dict:
    """Everything up to (not including) the initial fields, which need the subset mesh's cell centres."""
    L = p.size_m
    ztop = p.zmin + p.nz * p.dz
    _w(case / "system/blockMeshDict", "dictionary", "blockMeshDict", f"""
convertToMeters 1;
vertices ( (0 0 {p.zmin}) ({L} 0 {p.zmin}) ({L} {L} {p.zmin}) (0 {L} {p.zmin})
           (0 0 {ztop}) ({L} 0 {ztop}) ({L} {L} {ztop}) (0 {L} {ztop}) );
blocks ( hex (0 1 2 3 4 5 6 7) ({p.nx} {p.ny} {p.nz}) simpleGrading (1 1 1) );
boundary
(
    south {{ type patch; faces ((0 1 5 4)); }}
    north {{ type patch; faces ((3 7 6 2)); }}
    west  {{ type patch; faces ((0 4 7 3)); }}
    east  {{ type patch; faces ((1 2 6 5)); }}
    atmosphere {{ type patch; faces ((4 5 6 7)); }}
    floor {{ type wall; faces ((0 3 2 1)); }}
    walls {{ type wall; faces (); }}
);
""")
    T = t1 - t0
    _w(case / "system/controlDict", "dictionary", "controlDict", f"""
application interFoam;
startFrom startTime; startTime 0; stopAt endTime; endTime {T};
deltaT 0.01; writeControl adjustable; writeInterval {WRITE_DT_S}; purgeWrite 0;
writeFormat ascii; writePrecision 6; writeCompression off; timeFormat general; timePrecision 6;
runTimeModifiable no; adjustTimeStep yes; maxCo 0.9; maxAlphaCo 0.9; maxDeltaT 0.5;
""")
    _w(case / "system/fvSchemes", "dictionary", "fvSchemes", """
ddtSchemes { default Euler; }
gradSchemes { default Gauss linear; }
divSchemes
{
    div(rhoPhi,U) Gauss linearUpwind grad(U);
    div(phi,k) Gauss upwind;
    div(phi,omega) Gauss upwind;
    div(phi,alpha) Gauss vanLeer;
    div(phirb,alpha) Gauss linear;
    div(((rho*nuEff)*dev2(T(grad(U))))) Gauss linear;
}
laplacianSchemes { default Gauss linear corrected; }
wallDist { method meshWave; }
interpolationSchemes { default linear; }
snGradSchemes { default corrected; }
""")
    _w(case / "system/fvSolution", "dictionary", "fvSolution", """
solvers
{
    "alpha.water.*" { nAlphaCorr 2; nAlphaSubCycles 1; cAlpha 1; MULESCorr yes; nLimiterIter 5;
                      solver smoothSolver; smoother symGaussSeidel; tolerance 1e-8; relTol 0; }
    "pcorr.*" { solver PCG; preconditioner DIC; tolerance 1e-5; relTol 0; }
    p_rgh { solver GAMG; smoother DIC; tolerance 1e-7; relTol 0.05; }
    p_rghFinal { $p_rgh; relTol 0; }
    "U.*" { solver smoothSolver; smoother symGaussSeidel; tolerance 1e-6; relTol 0; }
    "(k|omega).*" { solver smoothSolver; smoother symGaussSeidel; tolerance 1e-7; relTol 0; }
}
PIMPLE { momentumPredictor no; nOuterCorrectors 1; nCorrectors 3; nNonOrthogonalCorrectors 0; }
relaxationFactors { equations { ".*" 1; } }
""")
    _w(case / "system/decomposeParDict", "dictionary", "decomposeParDict",
       f"\nnumberOfSubdomains {procs};\nmethod scotch;\n")
    _w(case / "system/fvOptions", "dictionary", "fvOptions", f"""
limitU
{{
    type limitVelocity;
    active yes;
    selectionMode all;
    max {U_CAP_M_S};
}}
""")
    _w(case / "constant/g", "uniformDimensionedVectorField", "g", "\ndimensions [0 1 -2 0 0 0 0];\nvalue (0 0 -9.81);\n")
    _w(case / "constant/transportProperties", "dictionary", "transportProperties", f"""
phases (water air);
water {{ transportModel Newtonian; nu 1e-06; rho {RHO_WATER}; }}
air {{ transportModel Newtonian; nu 1.48e-05; rho {RHO_AIR}; }}
sigma 0.07;
""")
    _w(case / "constant/turbulenceProperties", "dictionary", "turbulenceProperties",
       "\nsimulationType RAS;\nRAS { RASModel kOmegaSST; turbulence on; printCoeffs off; }\n")
    href = reference_level(p, forcing, t0)
    _w(case / "constant/hRef", "uniformDimensionedScalarField", "hRef", f"\ndimensions [0 1 0 0 0 0 0];\nvalue {href};\n")
    write_boundary_data(case, p, forcing, t0, t1, href)
    return {"ztop": ztop, "T": T, "href": href}


def side_points(p: Patch, side: str) -> np.ndarray:
    """Face centres of a full (pre-subset) side, (n, 3) in case coordinates."""
    c = (np.arange(p.nx) + 0.5) * p.cell_m
    z = p.zmin + (np.arange(p.nz) + 0.5) * p.dz
    H, Z = np.meshgrid(c, z)
    if side in ("south", "north"):
        y = 0.0 if side == "south" else p.size_m
        return np.column_stack([H.ravel(), np.full(H.size, y), Z.ravel()])
    x = 0.0 if side == "west" else p.size_m
    return np.column_stack([np.full(H.size, x), H.ravel(), Z.ravel()])


def _vec_list(a: np.ndarray) -> str:
    return f"{len(a)}\n(\n" + "\n".join(f"({x:.6g} {y:.6g} {z:.6g})" for x, y, z in a) + "\n)\n"


def _scalar_list(a: np.ndarray) -> str:
    return f"{len(a)}\n(\n" + "\n".join(f"{x:.6g}" for x in a) + "\n)\n"


def column_fields(wse: np.ndarray, u: np.ndarray, v: np.ndarray, zc: np.ndarray, dz: float):
    """alpha.water and U for cells at heights zc (broadcast with wse/u/v): fractional alpha at the interface,
    the depth-averaged velocity below the surface, at rest in the air."""
    alpha = np.clip((wse - (zc - dz / 2)) / dz, 0.0, 1.0)
    return alpha, u * alpha, v * alpha


def _bc_times(t0: float, t1: float) -> list[float]:
    return list(np.arange(0.0, t1 - t0, BC_DT_S)) + [t1 - t0]


def level_p_rgh(wse: np.ndarray, alpha: np.ndarray, href: float) -> np.ndarray:
    """Hydrostatic p_rgh (p_rgh = 0 in still air, as the atmosphere patch holds): (rho_w - rho_a) g (wse - hRef)
    below the surface."""
    return alpha * (RHO_WATER - RHO_AIR) * G * (wse - href)


def reference_level(p: Patch, forcing: Forcing, t0: float) -> float:
    """hRef: the median 2D water surface over the patch at t0. With hRef = 0, p_rgh jumps by (rho_w - rho_a) g wse
    across the free surface (~40 kPa at Lagos elevations); VOF's force-balance error scales with that jump and drove
    10 m/s air currents that grew until the solve failed. hRef near the surface makes p_rgh nearly continuous."""
    X, Y = np.meshgrid((np.arange(p.nx) + 0.5) * p.cell_m, (np.arange(p.ny) + 0.5) * p.cell_m)
    lon, lat = p.lonlat(X.ravel(), Y.ravel())
    return round(float(np.median(forcing.sample(lon, lat, t0)[0])), 3)


def write_boundary_data(case: Path, p: Patch, forcing: Forcing, t0: float, t1: float, href: float) -> None:
    """The 2D water level on each side as hydrostatic p_rgh, every BC_DT_S."""
    for side in SIDES:
        pts = side_points(p, side)
        base = case / "constant/boundaryData" / side
        base.mkdir(parents=True, exist_ok=True)
        (base / "points").write_text(_vec_list(pts))
        lon, lat = p.lonlat(pts[:, 0], pts[:, 1])
        for t in _bc_times(t0, t1):
            wse, u, v = forcing.sample(lon, lat, t0 + t)
            alpha, _, _ = column_fields(wse, u, v, pts[:, 2], p.dz)
            d = base / f"{t:g}"
            d.mkdir(exist_ok=True)
            (d / "p_rgh").write_text(_scalar_list(level_p_rgh(wse, alpha, href)))


def side_inlet_alpha(case: Path, p: Patch, forcing: Forcing, t0: float, t1: float) -> dict[str, np.ndarray]:
    """Window-mean 2D water fraction at each face of each side patch of the subset mesh (inletOutlet inletValue;
    the 2D level moves little over a patch window)."""
    from dryrun.patch3d.post import face_geometry, read_mesh

    pts, faces, _, bnd = read_mesh(case)
    out = {}
    for side in SIDES:
        st, n = bnd[side]
        fc, _ = face_geometry(pts, faces, range(st, st + n))
        lon, lat = p.lonlat(fc[:, 0], fc[:, 1])
        a = [column_fields(*forcing.sample(lon, lat, t0 + t), fc[:, 2], p.dz)[0] for t in _bc_times(t0, t1)]
        out[side] = np.mean(a, axis=0)
    return out


def write_cellset(case: Path, p: Patch) -> int:
    """cellSet `fluid` for subsetMesh: blockMesh numbers cells i + nx (j + ny k)."""
    fluid = np.nonzero(~p.solid().ravel())[0]  # [nz, ny, nx] ravel == i + nx (j + ny k)
    _w(case / "constant/polyMesh/sets/fluid", "cellSet", "fluid", _scalar_list(fluid.astype(np.int64)).replace(".0", ""))
    return int(fluid.size)


def read_cell_centres(case: Path, ncells: int) -> np.ndarray:
    from dryrun.patch3d.post import read_internal

    return read_internal(case / "0/C", ncells)


def write_initial_fields(case: Path, p: Patch, forcing: Forcing, t0: float, t1: float, C: np.ndarray,
                         href: float) -> dict:
    lon, lat = p.lonlat(C[:, 0], C[:, 1])
    wse, u, v = forcing.sample(lon, lat, t0)
    alpha, U, V = column_fields(wse, u, v, C[:, 2], p.dz)
    mapped = "{ type timeVaryingMappedFixedValue; offset 0; setAverage off; }"
    inlet = side_inlet_alpha(case, p, forcing, t0, t1)
    side_alpha = "\n".join(f"    {s} {{ type inletOutlet; inletValue nonuniform List<scalar> {_scalar_list(a)}; "
                           f"value nonuniform List<scalar> {_scalar_list(a)}; }}" for s, a in inlet.items())
    side_u = "\n".join(f"    {s} {{ type pressureInletOutletVelocity; value uniform (0 0 0); }}" for s in SIDES)
    side_p = "\n".join(f"    {s} {mapped}" for s in SIDES)
    walls = "    \"(walls|floor)\" {{ type {t}; {v} }}"
    _w(case / "0/alpha.water", "volScalarField", "alpha.water",
       "\ndimensions [0 0 0 0 0 0 0];\ninternalField nonuniform List<scalar> " + _scalar_list(alpha) + ";\n"
       "boundaryField\n{\n" + side_alpha + "\n    atmosphere { type inletOutlet; inletValue uniform 0; value uniform 0; }\n"
       + walls.format(t="zeroGradient", v="") + "\n}\n")
    _w(case / "0/U", "volVectorField", "U",
       "\ndimensions [0 1 -1 0 0 0 0];\ninternalField nonuniform List<vector> "
       + _vec_list(np.column_stack([U, V, np.zeros_like(U)])) + ";\n"
       "boundaryField\n{\n" + side_u + "\n    atmosphere { type pressureInletOutletVelocity; value uniform (0 0 0); }\n"
       + walls.format(t="noSlip", v="") + "\n}\n")
    _w(case / "0/p_rgh", "volScalarField", "p_rgh",
       "\ndimensions [1 -1 -2 0 0 0 0];\ninternalField nonuniform List<scalar> "
       + _scalar_list(level_p_rgh(wse, alpha, href)) + ";\nboundaryField\n{\n" + side_p
       + "\n    atmosphere { type totalPressure; p0 uniform 0; }\n"
       + walls.format(t="fixedFluxPressure", v="value uniform 0;") + "\n}\n")
    for name, cls, dims, val, wall in (
            ("k", "volScalarField", "[0 2 -2 0 0 0 0]", K_IN, "kqRWallFunction; value uniform " + str(K_IN)),
            ("omega", "volScalarField", "[0 0 -1 0 0 0 0]", OMEGA_IN, "omegaWallFunction; value uniform " + str(OMEGA_IN)),
            ("nut", "volScalarField", "[0 2 -1 0 0 0 0]", 0, f"nutkRoughWallFunction; Ks uniform {KS_GROUND_M}; "
                                                              "Cs uniform 0.5; value uniform 0")):
        open_bc = ("{ type calculated; value uniform 0; }" if name == "nut" else
                   f"{{ type inletOutlet; inletValue uniform {val}; value uniform {val}; }}")
        _w(case / f"0/{name}", cls, name, f"\ndimensions {dims};\ninternalField uniform {val};\nboundaryField\n{{\n"
           + "\n".join(f"    {s} {open_bc}" for s in (*SIDES, "atmosphere"))
           + f"\n    \"(walls|floor)\" {{ type {wall}; }}\n}}\n")
    cell_v = p.cell_m * p.cell_m * p.dz
    return {"water_m3_t0": round(float(alpha.sum() * cell_v), 1), "sides": "2D water level (hydrostatic p_rgh)", "href_m": href}


def procs_for(cells: int) -> int:
    import os

    return max(1, min(os.cpu_count() or 1, int(math.ceil(cells / 10000))))
