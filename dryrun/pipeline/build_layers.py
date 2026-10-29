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

from collections import deque

import numpy as np

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
DEM_TREATMENT = "leave"
DEM_SMOOTH_SIGMA_CELLS = 1.0
WATER_BED_M = -1.0
CANAL_BURN_M = 1.0


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


def water_masks(jrc_occurrence: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """JRC occurrence (%, NaN/255 = no data treated as land) -> (boundary_mask, exclude_mask) bool."""
    occ = np.asarray(jrc_occurrence, np.float32)
    water = np.nan_to_num(occ, nan=0.0) >= JRC_PERMANENT_PCT
    water &= occ <= 100  # 255 = JRC no-data
    labels, sizes = _components(water)
    boundary = np.zeros(water.shape, bool)
    edge = np.zeros(water.shape, bool)
    edge[0, :] = edge[-1, :] = edge[:, 0] = edge[:, -1] = True
    for k, size in enumerate(sizes, start=1):
        comp = labels == k
        if size >= BOUNDARY_MIN_CELLS or (comp & edge).sum() >= BOUNDARY_EDGE_MIN_CELLS:
            boundary |= comp
    return boundary, water


def treat_dem(dem: np.ndarray, boundary: np.ndarray, exclude: np.ndarray) -> np.ndarray:
    """Raw GLO-30 heights on the grid -> serving DEM (float32), per DEM_TREATMENT above."""
    z = np.asarray(dem, np.float64)
    land = ~exclude
    # Normalised convolution: smooth land with land only, so water heights never bleed into the shore.
    w = _gauss(land.astype(np.float64), DEM_SMOOTH_SIGMA_CELLS)
    zs = _gauss(np.where(land, z, 0.0), DEM_SMOOTH_SIGMA_CELLS) / np.where(w > 0, w, 1.0)
    out = np.where(land, zs, z)
    canal = exclude & ~boundary
    if canal.any():  # never above its own surface or the lowest adjacent bank, then burned
        banks = np.pad(np.where(land, out, np.inf), 1, constant_values=np.inf)
        ny, nx = z.shape
        low = np.min([banks[r:r + ny, c:c + nx] for r in range(3) for c in range(3)], axis=0)
        out[canal] = np.minimum(z, low)[canal] - CANAL_BURN_M
    out[boundary] = np.minimum(z[boundary], WATER_BED_M)
    return out.astype(np.float32)


def build(aoi_id: str, raw_dir: str) -> None:
    raise NotImplementedError("Eng D: read raw rasters, call the functions above, write layers + manifest")


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
