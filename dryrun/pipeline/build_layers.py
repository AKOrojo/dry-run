"""Derive SERVING layers from raw downloads (code: Eng D; Eng A owns the LUT values, rates and DEM
treatment and reviews every change).

Writes float32 .npy on the AOI grid (+ optional .tif copies for QGIS) and the manifest:
  dem.npy                treat_dem(): decided below (DEM_TREATMENT); a change after publishing means a
                         NEW aoi id (-v2): ids are immutable.
  manning.npy            WorldCover -> LANDCOVER_LUT[class][0]       (landcover_layers())
  infiltration.npy       WorldCover -> LANDCOVER_LUT[class][1]       (landcover_layers())
  drain_sink.npy         OSM waterway=drain|canal|ditch buffered 1 cell -> BASELINE_DRAIN_MM_H (assumption)
  boundary_mask.npy      JRC occurrence >= 90% AND part of a large or edge-touching water body (lagoon/sea),
                         held at tide level. Lekki-Ajah: lagoon is NORTH, Atlantic is SOUTH; never assume an edge.
  exclude_mask.npy       all permanent water (JRC >= 90%) incl. canals: never counted as flooding
  population.npy         WorldPop people per cell
Every LUT value and rate is an ASSUMPTION listed in the model card (README).

Eng A's decisions are encoded as the pure-numpy functions below so the rules live in one reviewed
place; Eng D's build() does the I/O (rasterio reads, OSM buffering, storage writes) and calls them.
"""

from __future__ import annotations

import argparse
import io
import json
from collections import deque
from collections.abc import Sequence
from pathlib import Path

import numpy as np

from dryrun import storage
from dryrun.contracts import AOIManifest, GridSpec
from dryrun.pipeline import osm
from dryrun.pipeline.ee_export import __doc__ as _grid_doc  # noqa: F401  (grid rules live there)

LANDCOVER_LUT = {  # WorldCover class: (manning_n, infiltration_mm_h)
    10: (0.10, 25.0),   # tree cover
    20: (0.08, 20.0),   # shrubland
    30: (0.05, 15.0),   # grassland
    40: (0.05, 12.0),   # cropland
    50: (0.05, 2.0),    # built-up: n raised from 0.015 (smooth concrete) because buildings stay
    #                     sub-grid at 30 m (DEM_TREATMENT="leave"), so blockage acts as roughness;
    #                     2 mm/h = mostly sealed, some unpaved compounds and setbacks
    60: (0.03, 8.0),    # bare / sparse
    80: (0.03, 0.0),    # permanent water
    90: (0.07, 3.0),    # herbaceous wetland (saturated, shallow water table)
    95: (0.10, 3.0),    # mangroves
}
LUT_DEFAULT = (0.05, 5.0)  # any class not in the LUT (none expected at Lagos)

# Removal rate (mm/h) on cells crossed by mapped drainage, OSM waterway tag -> rate. Lagos drains are
# widely silted or blocked by solid waste, so these are deliberately modest. Unmapped cells get 0;
# the agent's DrainUpgrade(add_mm_h=...) models new drains there.
BASELINE_DRAIN_MM_H = {"drain": 10.0, "ditch": 10.0, "canal": 25.0}

# JRC Global Surface Water occurrence (%) at or above which a cell is permanent water.
JRC_PERMANENT_PCT = 90
# A permanent-water body becomes OPEN BOUNDARY (held at the tide) if it is at least this many cells
# (~1 km2 at 30 m: the lagoon, the sea, big creeks) or touches the AOI edge with at least
# BOUNDARY_EDGE_MIN_CELLS cells (the sea / lagoon cut by the AOI box). Smaller water (ponds, canals)
# is excluded from flood stats but is NOT a boundary: it fills and spills like land.
BOUNDARY_MIN_CELLS = 1000
BOUNDARY_EDGE_MIN_CELLS = 50

# DEM treatment, decided Wed 11 AM. Copernicus GLO-30 is a DSM: building and tree tops bias it up.
#   "leave" (chosen): do NOT raise the DEM under buildings. At 30 m most Lagos streets are narrower than
#   a cell, so raising building cells would wall off real flow paths and invent ponding. Buildings act
#   through Manning's n (LUT above) and the 3x3 building-depth rule in exposure.py instead.
#   Plus light Gaussian smoothing (sigma = 1 cell) on land: Lagos is flat, so ~1-2 m DSM noise would
#   otherwise dominate flow paths. Light smoothing beats FABDEM here (FABDEM is non-commercial).
#   Permanent water: boundary cells set to at most WATER_BED_M (GLO-30 water surfaces are flattened to an
#   arbitrary height; the bed must sit below the tide or the lagoon is a dry cliff), and the remaining
#   permanent water (canals) is set CANAL_BURN_M below the lower of its own height and its lowest adjacent
#   bank, so 30 m cells and smoothing cannot break channel connectivity.
#   Inland AOIs (coastal=False, e.g. Texas Guadalupe): no sea, so no JRC boundary; the OSM river is
#   burned like a canal, and the river's exit on one AOI edge becomes a free-outflow OUTLET: boundary
#   cells whose bed stays at ground level (OUTLET_DROP_M below their lowest neighbour). The default tide
#   (-0.5 m) is far below an inland bed, so outlet cells hold no water and pass everything out.
DEM_TREATMENT = "leave"
DEM_SMOOTH_SIGMA_CELLS = 1.0
WATER_BED_M = -1.0
CANAL_BURN_M = 1.0
OUTLET_DROP_M = 0.5
#   Inland rivers are also CARVED: every river cell connected to the outlet is lowered (never raised) so the
#   channel runs downhill to it by at least CARVE_DROP_M per cell. At 2" a narrow canyon averages into
#   ridges of 10-28 m across the bed (South Fork Guadalupe), which the local canal burn cannot breach.
#   River cells get RIVER_MANNING, a natural clean channel (Chow 1959), not the land cover around them.
CARVE_DROP_M = 0.01
RIVER_MANNING = 0.035


def landcover_layers(worldcover: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """WorldCover class raster (MODE-resampled to the grid) -> (manning, infiltration_mm_h) float32."""
    wc = np.asarray(worldcover).astype(int)
    man = np.full(wc.shape, LUT_DEFAULT[0], np.float32)
    inf = np.full(wc.shape, LUT_DEFAULT[1], np.float32)
    for cls, (n, f) in LANDCOVER_LUT.items():
        man[wc == cls] = n
        inf[wc == cls] = f
    return man, inf


def drain_sink(waterway_cells: dict[str, np.ndarray]) -> np.ndarray:
    """{"drain": bool mask, "canal": bool mask, ...} (OSM lines buffered 1 cell, by D) -> mm/h float32.
    Where kinds overlap the larger rate wins."""
    shape = next(iter(waterway_cells.values())).shape
    out = np.zeros(shape, np.float32)
    for kind, mask in waterway_cells.items():
        out[np.asarray(mask, bool)] = np.maximum(out[np.asarray(mask, bool)], BASELINE_DRAIN_MM_H[kind])
    return out


def water_masks(jrc_occurrence: np.ndarray, coastal: bool = True) -> tuple[np.ndarray, np.ndarray]:
    """JRC occurrence (%, NaN/255 = no data treated as land) -> (boundary_mask, exclude_mask) bool.

    coastal=False (inland AOI): no JRC water becomes boundary; add river_outlet() cells instead.
    """
    occ = np.asarray(jrc_occurrence, np.float32)
    water = np.nan_to_num(occ, nan=0.0) >= JRC_PERMANENT_PCT
    water &= occ <= 100  # 255 = JRC no-data
    boundary = np.zeros(water.shape, bool)
    if not coastal:
        return boundary, water
    labels, sizes = _components(water)
    edge = np.zeros(water.shape, bool)
    edge[0, :] = edge[-1, :] = edge[:, 0] = edge[:, -1] = True
    for k, size in enumerate(sizes, start=1):
        comp = labels == k
        if size >= BOUNDARY_MIN_CELLS or (comp & edge).sum() >= BOUNDARY_EDGE_MIN_CELLS:
            boundary |= comp
    return boundary, water


def river_outlet(river_mask: np.ndarray, side: str) -> np.ndarray:
    """River cells on one AOI edge ("north" | "south" | "east" | "west") -> outlet mask (bool)."""
    river = np.asarray(river_mask) > 0.5
    out = np.zeros(river.shape, bool)
    edge = {"north": (0, slice(None)), "south": (-1, slice(None)),
            "west": (slice(None), 0), "east": (slice(None), -1)}[side]
    out[edge] = river[edge]
    if not out.any():
        raise ValueError(f"river mask does not reach the {side} edge: no outlet")
    return out


def carve_rivers(dem: np.ndarray, river: np.ndarray, outlet: np.ndarray) -> np.ndarray:
    """River cells lowered so each runs downhill to the outlet (breaching, never filling).

    BFS from the outlet over 8-connected river cells gives every connected cell a downstream parent;
    processing the farthest cells first, each parent ends at most CARVE_DROP_M below its lowest child.
    """
    z = np.asarray(dem, np.float64).copy()
    ny, nx = z.shape
    dist = np.full(z.shape, -1, np.int64)
    parent: dict[tuple[int, int], tuple[int, int]] = {}
    queue = deque()
    for r, c in zip(*np.nonzero(outlet)):
        dist[r, c] = 0
        queue.append((int(r), int(c)))
    while queue:
        r, c = queue.popleft()
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                rr, cc = r + dr, c + dc
                if (dr or dc) and 0 <= rr < ny and 0 <= cc < nx and river[rr, cc] and dist[rr, cc] < 0:
                    dist[rr, cc] = dist[r, c] + 1
                    parent[(rr, cc)] = (r, c)
                    queue.append((rr, cc))
    for cell in sorted(parent, key=lambda p: -dist[p]):
        down = parent[cell]
        z[down] = min(z[down], z[cell] - CARVE_DROP_M)
    return z.astype(np.float32)


def treat_dem(dem: np.ndarray, boundary: np.ndarray, exclude: np.ndarray,
              outlet: np.ndarray | None = None, smooth: bool = True) -> np.ndarray:
    """Raw GLO-30 heights on the grid -> serving DEM (float32), per DEM_TREATMENT above.

    outlet: boundary cells that are a river exit (or an edge-outflow ring), not sea; their bed is not lowered
    to WATER_BED_M. smooth=False for lidar DEMs (no DSM noise to remove, and smoothing would fill street gutters).
    """
    z = np.asarray(dem, np.float64)
    land = ~exclude
    if smooth:
        # Normalised convolution: smooth land with land only, so water heights never bleed into the shore.
        w = _gauss(land.astype(np.float64), DEM_SMOOTH_SIGMA_CELLS)
        zs = _gauss(np.where(land, z, 0.0), DEM_SMOOTH_SIGMA_CELLS) / np.where(w > 0, w, 1.0)
        out = np.where(land, zs, z)
    else:
        out = z.copy()
    ny, nx = z.shape
    canal = exclude & ~boundary
    if canal.any():  # never above its own surface or the lowest adjacent bank, then burned
        banks = np.pad(np.where(land, out, np.inf), 1, constant_values=np.inf)
        low = np.min([banks[r:r + ny, c:c + nx] for r in range(3) for c in range(3)], axis=0)
        out[canal] = np.minimum(z, low)[canal] - CANAL_BURN_M
    sea = boundary if outlet is None else boundary & ~outlet
    out[sea] = np.minimum(z[sea], WATER_BED_M)
    if outlet is not None and outlet.any():  # a small drop below the lowest neighbour, so the river exits
        nb = np.pad(np.where(outlet, np.inf, out), 1, constant_values=np.inf)
        low = np.min([nb[r:r + ny, c:c + nx] for r in range(3) for c in range(3)], axis=0)
        out[outlet] = np.minimum(out, low)[outlet] - OUTLET_DROP_M
    return out.astype(np.float32)


def waterway_cells(grid: GridSpec, lines_by_kind: dict[str, list[list[tuple[float, float]]]]) -> dict[str, np.ndarray]:
    """Rasterise waterways and buffer by one cell, without wrapping at edges."""
    masks = {}
    for kind in BASELINE_DRAIN_MM_H:
        mask = np.zeros((grid.ny, grid.nx), bool)
        for coords in lines_by_kind.get(kind, []):
            if not coords:
                continue
            cells = np.asarray(osm.line_cells(grid, coords), int).reshape(-1, 2)
            mask[cells[:, 0], cells[:, 1]] = True
        padded = np.pad(mask, 1)
        masks[kind] = np.logical_or.reduce([
            padded[r:r + grid.ny, c:c + grid.nx] for r in range(3) for c in range(3)
        ])
    return masks


def build(aoi_id: str, raw_dir: str, osm_files: dict[str, str] | None = None,
          building_csvs=(), name: str | None = None, full: bool = False,
          keywords: Sequence[str] | None = None, place_aliases: dict | None = None,
          building_source: str = "open_buildings", debug_layers: bool = False,
          place_tags: dict | None = None, corridor_tags: dict | None = None,
          coastal: bool = True, outlet_side: str | None = None, inflows_config: dict | None = None,
          shelter_min_above_river_m: float | None = None, edge_outflow: bool = False, smooth_dem: bool = True,
          land_drain_mm_h: float | None = None, dem_credit: str | None = None) -> AOIManifest:
    """Publish serving layers from raw exports; the manifest is the final write.

    Inland AOIs: coastal=False plus outlet_side ("east", ...): the OSM river (waterway=river|stream from
    osm_files["features"]) is burned like a canal and exits through river_outlet() on that edge.
    inflows_config ({gauges: path, t0_utc, hours, sources, note}): river inflows from USGS gauges, written as the
    `inflows` layer by Eng A's inflows.build_inflows() (needs the river mask, so outlet_side or debug_layers).
    edge_outflow (inland boxes with no river, e.g. NYC Queens): the solver's outer faces are walls, so the outer
    1-cell ring becomes boundary (free outflow, treated like a river outlet: ground level less OUTLET_DROP_M), and
    all JRC permanent water inside becomes open-water boundary too.
    smooth_dem=False for lidar DEMs. land_drain_mm_h: a uniform sink on every land cell (combined sewers),
    combined with the OSM drain sink by max. dem_credit: the DEM's credit when grid.json has none (dem supplied
    by another workstream, e.g. `ee_export --skip dem`).
    """
    if inflows_config and not (outlet_side or debug_layers):
        raise ValueError("inflows need the river mask: pass outlet_side (or debug_layers)")
    if storage._exists("data", f"{aoi_id}/manifest.json"):
        raise ValueError("AOI ids are immutable; publish a new id")
    reader = osm.building_reader(building_source)
    folder = Path(raw_dir)
    metadata = json.loads(storage.read_local_file(folder / "grid.json"))
    grid = GridSpec.model_validate({k: v for k, v in metadata.items() if k in GridSpec.model_fields})
    raw = {k: np.load(io.BytesIO(storage.read_local_file(folder / f"{k}.npy")), allow_pickle=False)
           for k in ("dem", "worldcover", "jrc_occurrence", "population")}
    for key, arr in raw.items():
        if arr.shape != (grid.ny, grid.nx):
            raise ValueError(f"{key}: expected shape {(grid.ny, grid.nx)}, got {arr.shape}")
    if not np.isfinite(raw["dem"]).all():
        raise ValueError("DEM must be finite")
    lines = {kind: [] for kind in BASELINE_DRAIN_MM_H}
    river_mask = np.zeros((grid.ny, grid.nx), bool)
    features_path = (osm_files or {}).get("features")
    if features_path:
        import osmnx as ox

        kinds = list(BASELINE_DRAIN_MM_H) + (["river", "stream"] if debug_layers or outlet_side else [])
        features = ox.features_from_xml(features_path, tags={"waterway": kinds})
        for idx, feature in features.iterrows():
            if isinstance(idx, tuple) and idx[0] != "way":
                continue
            kind, geom = feature.get("waterway"), feature.geometry
            if geom is None or (kind not in lines and kind not in ("river", "stream")):
                continue
            if kind in ("river", "stream"):
                parts = [geom] if geom.geom_type == "LineString" else (
                    geom.geoms if geom.geom_type == "MultiLineString" else [])
                for part in parts:
                    cells = np.asarray(osm.line_cells(grid, list(part.coords)), int).reshape(-1, 2)
                    river_mask[cells[:, 0], cells[:, 1]] = True
                continue
            if geom.geom_type == "LineString":
                lines[kind].append(list(geom.coords))
            elif geom.geom_type == "MultiLineString":
                lines[kind].extend(list(part.coords) for part in geom.geoms)
    boundary, exclude = water_masks(raw["jrc_occurrence"], coastal=coastal)
    outlet = None
    if outlet_side:
        exclude |= river_mask  # the channel is burned like a canal and never counts as flooding
        outlet = river_outlet(river_mask, outlet_side)
        boundary |= outlet
    river_outlet_mask = outlet
    if edge_outflow:
        ring = np.zeros((grid.ny, grid.nx), bool)
        ring[0, :] = ring[-1, :] = ring[:, 0] = ring[:, -1] = True
        boundary |= exclude | ring
        outlet = ring if outlet is None else outlet | ring
    dem = treat_dem(raw["dem"], boundary, exclude, outlet, smooth=smooth_dem)
    if river_outlet_mask is not None:
        dem = carve_rivers(dem, river_mask, river_outlet_mask)
    if not np.isfinite(dem).all():
        raise ValueError("treated DEM must be finite")
    manning, infiltration = landcover_layers(raw["worldcover"])
    if river_outlet_mask is not None:
        manning[river_mask] = RIVER_MANNING
    sink = drain_sink(waterway_cells(grid, lines))
    if land_drain_mm_h:
        sink = np.maximum(sink, np.where(exclude | boundary, 0.0, land_drain_mm_h)).astype(np.float32)
    population = np.nan_to_num(raw["population"].astype(np.float32), nan=0.0)
    rasters = {"dem": dem, "manning": manning, "infiltration_mm_h": infiltration,
               "drain_sink_mm_h": sink, "boundary_mask": boundary, "exclude_mask": exclude,
               "population": population}
    layers = {key: f"{key}.npy" for key in rasters}
    layers.update(infiltration_mm_h="infiltration.npy", drain_sink_mm_h="drain_sink.npy")

    def credit(key):
        source = metadata.get("sources", {}).get(key, {})
        return source if isinstance(source, str) else "; ".join(
            str(source[k]) for k in ("credit", "licence") if k in source)

    wc_rule = "derived: WorldCover -> LANDCOVER_LUT (assumed values, see README model card)"
    sources = {
        "dem": f"{dem_credit or credit('dem')}; derived: treat_dem / DEM_TREATMENT"
               f"{'' if smooth_dem else ', unsmoothed (lidar)'} (see README model card)",
        "manning": f"{credit('worldcover')}; {wc_rule}",
        "infiltration_mm_h": f"{credit('worldcover')}; {wc_rule}",
        "boundary_mask": f"{credit('jrc_occurrence')}; derived: water_masks / BOUNDARY rules"
                         f"{'; plus the outer cell ring (edge outflow)' if edge_outflow else ''}",
        "exclude_mask": f"{credit('jrc_occurrence')}; derived: water_masks / JRC_PERMANENT_PCT",
        "population": credit("population"),
        "drain_sink_mm_h": ("© OpenStreetMap contributors, ODbL 1.0; " if features_path else
                            "empty: no OSM waterways supplied; ") +
                           "derived: BASELINE_DRAIN_MM_H (assumed values, see README model card)" +
                           (f"; plus {land_drain_mm_h:g} mm/h on all land (combined sewers, assumed)" if land_drain_mm_h
                            else ""),
    }
    for key, arr in rasters.items():
        buf = io.BytesIO()
        np.save(buf, arr.astype(np.float32))
        storage.write_aoi_file(aoi_id, layers[key], buf.getvalue())
    if debug_layers:
        for key, arr in {"jrc_occurrence": raw["jrc_occurrence"], "river_mask": river_mask}.items():
            buf = io.BytesIO()
            np.save(buf, arr)
            storage.write_aoi_file(aoi_id, f"{key}.npy", buf.getvalue())
    report = None
    if full:
        vector_layers, vector_sources, report = osm.build(
            aoi_id, grid, dem, exclude, building_csvs, osm_files,
            building_source=building_source, keywords=keywords, place_aliases=place_aliases,
            place_tags=place_tags, corridor_tags=corridor_tags,
            river_mask=river_mask if river_mask.any() else None, shelter_min_above_river_m=shelter_min_above_river_m)
    else:
        vector_layers = {"roads_graph": "roads.graphml", "shelters": "shelters.geojson",
                         "places": "places.geojson", "buildings": "buildings_index.json",
                         "buildings_geojson": "buildings.geojson"}
        vector_sources = {key: "empty: vector extraction not requested" for key in vector_layers}
        for filename, data in osm.empty_layers().items():
            content_type = "application/xml" if filename.endswith("graphml") else "application/geo+json"
            storage.write_aoi_file(aoi_id, filename, data, content_type)
        index, geo = osm.buildings_layers(grid, reader(grid, building_csvs)) if building_csvs else (
            {"ids": [], "row": [], "col": []}, {"type": "FeatureCollection", "features": []})
        storage.write_aoi_file(aoi_id, "buildings_index.json", json.dumps(index).encode(), "application/json")
        storage.write_aoi_file(aoi_id, "buildings.geojson", json.dumps(geo).encode(), "application/geo+json")
        if building_csvs:
            ob = f"Google Open Buildings v3, CC BY 4.0; height {osm.DEFAULT_HEIGHT_M:g} m assumed"
            if building_source == "ms":
                ob = "Microsoft Global ML Building Footprints, ODbL"
            elif building_source == "nyc_footprints":
                ob = ("NYC Open Data BUILDING footprints (5zhs-2jue), City of New York, NYC Open Data terms of use; "
                      "height from HEIGHT_ROOF")
            vector_sources.update(buildings=ob, buildings_geojson=ob)
    layers.update(vector_layers)
    sources.update(vector_sources)
    if inflows_config:
        from dryrun.pipeline import inflows

        gauges = json.loads(storage.read_local_file(inflows_config["gauges"]))
        gauges = gauges.get("sites", gauges)  # usgs.py writes {units, source, sites: {site: {rows, ...}}}
        layer = inflows.build_inflows(grid, river_mask, gauges, inflows_config["t0_utc"], inflows_config["hours"],
                                      inflows_config["sources"], inflows_config.get("note", ""), boundary=boundary)
        storage.write_aoi_file(aoi_id, "inflows.json", json.dumps(layer).encode(), "application/json")
        layers["inflows"] = "inflows.json"
        sources["inflows"] = "USGS NWIS instantaneous values (provisional); " + (layer.get("note") or "see inflows.py")
    manifest = AOIManifest(aoi_id=aoi_id, name=name or aoi_id, grid=grid, layers=layers,
                           sources=sources, is_synthetic=False)
    storage.write_aoi_file(aoi_id, "manifest.json", manifest.model_dump_json(indent=2).encode(), "application/json")
    for key, arr in rasters.items():
        print(f"{key}: min={arr.min():g} max={arr.max():g}")
    print(f"boundary cells={boundary.sum()} exclude cells={exclude.sum()} "
          f"drain cells={np.count_nonzero(sink)} people total={population.sum(dtype=np.float64):g}")
    if report is not None:
        print(f"OSM: {report}")
    return manifest


# ------------------------------------------------------------------------------------------ helpers
def _gauss(a: np.ndarray, sigma: float) -> np.ndarray:
    r = max(1, int(round(3 * sigma)))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    p = np.pad(a, r, mode="edge")
    p = sum(k[i] * p[:, i:i + a.shape[1]] for i in range(2 * r + 1))
    return sum(k[i] * p[i:i + a.shape[0], :] for i in range(2 * r + 1))


def _components(mask: np.ndarray) -> tuple[np.ndarray, list[int]]:
    """4-connected labels (1..K) and sizes. Offline only, so a plain BFS is fine (no scipy)."""
    labels = np.zeros(mask.shape, np.int32)
    sizes: list[int] = []
    ny, nx = mask.shape
    for r0, c0 in np.argwhere(mask):
        if labels[r0, c0]:
            continue
        k = len(sizes) + 1
        labels[r0, c0] = k
        q, n = deque([(r0, c0)]), 0
        while q:
            r, c = q.popleft()
            n += 1
            for rr, cc in ((r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)):
                if 0 <= rr < ny and 0 <= cc < nx and mask[rr, cc] and not labels[rr, cc]:
                    labels[rr, cc] = k
                    q.append((rr, cc))
        sizes.append(n)
    return labels, sizes


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--aoi-id", required=True)
    parser.add_argument("--raw", required=True)
    parser.add_argument("--osm-features")
    parser.add_argument("--osm-roads")
    parser.add_argument("--buildings", nargs="+", default=())
    parser.add_argument("--full", action="store_true")
    parser.add_argument("--name")
    parser.add_argument("--keywords-file")
    parser.add_argument("--building-source", choices=("open_buildings", "ms", "nyc_footprints"), default="open_buildings")
    parser.add_argument("--debug-layers", action="store_true")
    parser.add_argument("--place-config", help="JSON: {keywords, place_aliases, place_tags, corridor_tags}")
    parser.add_argument("--inland", action="store_true", help="no sea: no JRC boundary (needs --outlet-side)")
    parser.add_argument("--outlet-side", choices=("north", "south", "east", "west"),
                        help="edge where the OSM river leaves the AOI (free outflow)")
    parser.add_argument("--inflows-config", help="JSON: {gauges, t0_utc, hours, sources, note} (pipeline/inflows.py)")
    parser.add_argument("--edge-outflow", action="store_true", help="outer cell ring drains freely (inland, no river)")
    parser.add_argument("--no-smooth", action="store_true", help="lidar DEM: skip the land smoothing")
    parser.add_argument("--land-drain-mm-h", type=float, help="uniform sink on all land cells (combined sewers)")
    parser.add_argument("--dem-credit", help="DEM credit when grid.json has none (DEM supplied separately)")
    args = parser.parse_args()
    if args.inland and not (args.outlet_side or args.edge_outflow):
        parser.error("--inland needs --outlet-side or --edge-outflow, or water has no way out")
    osm_files = {k: v for k, v in (("features", args.osm_features), ("roads", args.osm_roads)) if v}
    keywords = None
    if args.keywords_file:
        keywords = [line.strip() for line in storage.read_local_file(args.keywords_file).decode().splitlines()
                    if line.strip()]
    cfg = json.loads(storage.read_local_file(args.place_config)) if args.place_config else {}
    build(args.aoi_id, args.raw, osm_files or None, args.buildings, args.name, args.full,
          keywords=cfg.get("keywords", keywords), place_aliases=cfg.get("place_aliases"),
          building_source=args.building_source, debug_layers=args.debug_layers,
          place_tags=cfg.get("place_tags"), corridor_tags=cfg.get("corridor_tags"),
          shelter_min_above_river_m=cfg.get("shelter_min_above_river_m"),
          coastal=not args.inland, outlet_side=args.outlet_side,
          inflows_config=json.loads(storage.read_local_file(args.inflows_config)) if args.inflows_config else None,
          edge_outflow=args.edge_outflow, smooth_dem=not args.no_smooth, land_drain_mm_h=args.land_drain_mm_h,
          dem_credit=args.dem_credit)


if __name__ == "__main__":
    main()
