"""Derive SERVING layers from raw downloads (code: Eng D; Eng A owns the LUT values, rates and DEM
treatment and reviews every change).

Writes float32 .npy on the AOI grid (+ optional .tif copies for QGIS) and the manifest:
  dem.npy                DEM treatment decided by Wed 11 AM (raise under buildings vs. leave);
                         a change after publishing means a NEW aoi id (-v2): ids are immutable.
  manning.npy            WorldCover -> LANDCOVER_LUT[class][0]
  infiltration.npy       WorldCover -> LANDCOVER_LUT[class][1]
  drain_sink.npy         OSM waterway=drain|canal|ditch buffered 1 cell -> baseline rate (assumption)
  boundary_mask.npy      JRC occurrence >= 90% AND connected to the lagoon/sea (held at tide level).
                         Lekki-Ajah: lagoon is NORTH, Atlantic is SOUTH; never assume an edge.
  exclude_mask.npy       all permanent water (JRC >= 90%) incl. canals: never counted as flooding
  population.npy         WorldPop people per cell
Every LUT value and rate is an ASSUMPTION listed in the model card.
"""

from dryrun.pipeline.ee_export import __doc__ as _grid_doc  # noqa: F401  (grid rules live there)

LANDCOVER_LUT = {  # WorldCover class: (manning_n, infiltration_mm_h)
    10: (0.10, 25.0),   # tree cover
    20: (0.08, 20.0),   # shrubland
    30: (0.05, 15.0),   # grassland
    40: (0.05, 12.0),   # cropland
    50: (0.015, 1.0),   # built-up
    60: (0.03, 8.0),    # bare / sparse
    80: (0.03, 0.0),    # permanent water
    90: (0.07, 3.0),    # herbaceous wetland
    95: (0.10, 3.0),    # mangroves
}


def build(aoi_id: str, raw_dir: str) -> None:
    raise NotImplementedError("Eng A + D, Tue PM / Wed AM")
