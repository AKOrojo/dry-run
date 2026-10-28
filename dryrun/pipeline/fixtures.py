"""Synthetic AOI fixture (owner: Eng D). Run: `make fixtures`.

Purpose: every workstream can start on Day 1 without waiting for Earth Engine
exports. It writes a 120x120 grid at 30 m that obeys the exact AOIManifest
contract, so code written against it works unchanged on real Lagos data.
Layers are .npy / .geojson / .graphml so it needs only numpy + networkx.
"""

from __future__ import annotations

import io
import json

import networkx as nx
import numpy as np

from dryrun import storage
from dryrun.contracts import AOIManifest, GridSpec

AOI_ID = "fixture-synthetic"
N = 120
CELL = 30.0
# Nominal placement near Lekki, Lagos so the globe camera lands somewhere sensible.
WEST, NORTH = 3.470, 6.470
DEG_LON = CELL / (111_320 * np.cos(np.radians(6.45)))
DEG_LAT = CELL / 110_574


def cell_to_lonlat(r: float, c: float) -> tuple[float, float]:
    return WEST + (c + 0.5) * DEG_LON, NORTH - (r + 0.5) * DEG_LAT


def _npy(arr: np.ndarray) -> bytes:
    buf = io.BytesIO()
    np.save(buf, arr.astype(np.float32))
    return buf.getvalue()


def build(seed: int = 7) -> AOIManifest:
    rng = np.random.default_rng(seed)
    rr, cc = np.mgrid[0:N, 0:N].astype(np.float32)

    # Terrain: falls ~6 m north->south toward a "lagoon" row band, with bumps and pits.
    dem = 6.0 - 6.0 * rr / N
    dem += 0.6 * np.sin(cc / 9.0) * np.cos(rr / 13.0)
    for _ in range(6):  # depressions = ponding hot spots
        r0, c0 = rng.integers(15, N - 25, 2)
        dem -= 1.2 * np.exp(-(((rr - r0) ** 2 + (cc - c0) ** 2) / (2 * 6.0**2)))
    channel_c = (N // 2 + 10 * np.sin(np.arange(N) / 17.0)).astype(int)
    channel = np.zeros((N, N), bool)
    for r in range(N):
        channel[r, max(channel_c[r] - 1, 0) : channel_c[r] + 2] = True
    dem[channel] -= 1.5
    dem[-6:, :] = np.minimum(dem[-6:, :], -0.5)  # lagoon band along the south edge
    lagoon = np.zeros((N, N), bool)
    lagoon[-3:, :] = True  # open water held at tide level
    exclude = lagoon | channel  # permanent water never counts as flooding

    urban = (rng.random((N, N)) < 0.55) & ~channel
    manning = np.where(urban, 0.035, 0.06).astype(np.float32)
    infil = np.where(urban, 2.0, 15.0).astype(np.float32)
    sink = np.where(channel, 25.0, 0.0).astype(np.float32)  # baseline drains
    pop = np.where(urban, rng.gamma(2.0, 25.0, (N, N)), rng.gamma(1.0, 3.0, (N, N)))

    # Buildings: small squares on urban cells.
    feats = []
    for i, (r, c) in enumerate(np.argwhere(urban)[::7]):
        lon, lat = cell_to_lonlat(r, c)
        d = DEG_LON * 0.3
        ring = [[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]
        feats.append({
            "type": "Feature",
            "properties": {"id": f"b{i}", "height_m": float(rng.choice([3, 6, 9, 12])), "row": int(r), "col": int(c)},
            "geometry": {"type": "Polygon", "coordinates": [ring]},
        })
    buildings = {"type": "FeatureCollection", "features": feats}

    # Roads: grid every 8 cells, edges carry length + the cells they cross.
    g = nx.Graph()
    step = 8
    for r in range(4, N - 6, step):
        for c in range(4, N, step):
            lon, lat = cell_to_lonlat(r, c)
            g.add_node(f"n{r}_{c}", x=lon, y=lat, row=r, col=c)
    for r in range(4, N - 6, step):
        for c in range(4, N, step):
            for dr, dc in ((step, 0), (0, step)):
                r2, c2 = r + dr, c + dc
                if g.has_node(f"n{r2}_{c2}"):
                    cells = [(r + k * np.sign(dr), c + k * np.sign(dc)) for k in range(step + 1)]
                    bridge = any(channel[a, b] for a, b in cells)
                    g.add_edge(
                        f"n{r}_{c}", f"n{r2}_{c2}", length_m=step * CELL, drive=1, bridge=int(bridge),
                        cells=json.dumps([[int(a), int(b)] for a, b in cells]),
                    )
    gbuf = io.BytesIO()
    nx.write_graphml(g, gbuf)

    index = {"ids": [f["properties"]["id"] for f in feats],
             "row": [f["properties"]["row"] for f in feats], "col": [f["properties"]["col"] for f in feats]}

    def _box(name, kind, r0, c0, r1, c1):
        (w0, n0), (e0, s0) = cell_to_lonlat(r0, c0), cell_to_lonlat(r1, c1)
        ring = [[w0, n0], [e0, n0], [e0, s0], [w0, s0], [w0, n0]]
        return {"type": "Feature", "properties": {"name": name, "kind": kind},
                "geometry": {"type": "Polygon", "coordinates": [ring]}}

    places = {"type": "FeatureCollection", "features": [
        _box("North Estate (synthetic)", "neighbourhood", 5, 5, 40, 50),
        _box("Canal Corridor (synthetic)", "corridor", 0, 50, 114, 75),
        _box("Lagoon Front (synthetic)", "neighbourhood", 80, 0, 112, 119),
        _box("Market Low Area (synthetic)", "low_area", 50, 80, 80, 115),
        _box("Open Field (synthetic)", "open_land", 44, 20, 58, 40),
    ]}

    shelters = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"name": n, "row": r, "col": c},
         "geometry": {"type": "Point", "coordinates": list(cell_to_lonlat(r, c))}}
        for n, r, c in (("Shelter A (school)", 12, 20), ("Shelter B (church)", 10, 100))
    ]}

    grid = GridSpec(
        cell_size_m=CELL, dx_m=CELL, dy_m=CELL, nx=N, ny=N,
        bounds_wgs84=(WEST, NORTH - N * DEG_LAT, WEST + N * DEG_LON, NORTH),
    )
    manifest = AOIManifest(
        aoi_id=AOI_ID, name="Synthetic fixture (NOT real terrain)", grid=grid, is_synthetic=True,
        layers={
            "dem": "dem.npy", "manning": "manning.npy", "infiltration_mm_h": "infiltration.npy",
            "drain_sink_mm_h": "drain_sink.npy", "population": "population.npy",
            "boundary_mask": "boundary_mask.npy", "exclude_mask": "exclude_mask.npy",
            "buildings": "buildings_index.json", "buildings_geojson": "buildings.geojson",
            "roads_graph": "roads.graphml", "shelters": "shelters.geojson", "places": "places.geojson",
        },
        sources={k: "synthetic (generated by pipeline/fixtures.py)" for k in (
            "dem", "manning", "infiltration_mm_h", "drain_sink_mm_h", "population", "boundary_mask",
            "exclude_mask", "buildings", "buildings_geojson", "roads_graph", "shelters", "places")},
    )
    w = storage.write_aoi_file
    for name, arr in (("dem", dem), ("manning", manning), ("infiltration", infil), ("drain_sink", sink),
                      ("population", pop), ("boundary_mask", lagoon), ("exclude_mask", exclude)):
        w(AOI_ID, f"{name}.npy", _npy(arr))
    w(AOI_ID, "buildings_index.json", json.dumps(index).encode(), "application/json")
    w(AOI_ID, "places.geojson", json.dumps(places).encode(), "application/geo+json")
    w(AOI_ID, "buildings.geojson", json.dumps(buildings).encode(), "application/geo+json")
    w(AOI_ID, "roads.graphml", gbuf.getvalue(), "application/xml")
    w(AOI_ID, "shelters.geojson", json.dumps(shelters).encode(), "application/geo+json")
    w(AOI_ID, "manifest.json", manifest.model_dump_json(indent=2).encode(), "application/json")
    return manifest


if __name__ == "__main__":
    m = build()
    print(f"wrote AOI {m.aoi_id}: {m.grid.nx}x{m.grid.ny} @ {m.grid.cell_size_m} m")
