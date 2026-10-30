"""Rain field preview for the Scenario tab (owner: Eng A; route POST /api/aoi/{aoi_id}/rain_field).

The storm-total depth per cell exactly as the solver will apply it (interventions.rain_total_mm), drawn in the
design system's depth-3 blue with opacity rising with depth, plus the numbers the UI shows beside it.
"""

from __future__ import annotations

import base64
import io

import numpy as np
from PIL import Image

from dryrun import storage
from dryrun.contracts import RainCell, ScenarioSpec
from dryrun.sim import interventions

RAIN_RGB = (0x42, 0x92, 0xC6)  # --depth-3
MAX_ALPHA = 0.8
PEAK_WARN_MM_H = 100.0  # above this, warn; measured 1 h extremes: 133-153 mm/h (Texas, Jul 2025)
OUTSIDE_WARN = 0.25  # share of generated rain falling outside the AOI


def png(mm: np.ndarray, vmax: float) -> bytes:
    rgba = np.zeros(mm.shape + (4,), np.uint8)
    rgba[..., :3] = RAIN_RGB
    a = np.clip(mm / vmax, 0, 1) * MAX_ALPHA if vmax > 0 else np.zeros(mm.shape)
    rgba[..., 3] = np.round(np.where(mm >= 0.5, a, 0) * 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "PNG", compress_level=6)
    return buf.getvalue()


def peak_rate_mm_h(spec: ScenarioSpec) -> float:
    """Peak point intensity of the temporal pattern (centre of a cell, inside a polygon, or anywhere)."""
    t = np.linspace(0, spec.storm.duration_h * 3600, 721)
    return float(max(interventions.rain_rate_mm_h(spec, x) for x in t))


def preview(spec: ScenarioSpec) -> dict:
    aoi = storage.load_aoi(spec.aoi_id)
    g = aoi.grid
    interventions.validate_areas(spec, g)
    mm = interventions.rain_total_mm(spec, g)
    field = interventions.rain_field(spec, g)
    cell_m2 = g.dx_m * g.dy_m
    in_aoi = float(mm.sum()) / 1000 * cell_m2
    if field is None:
        generated = in_aoi
    else:
        generated = spec.storm.total_mm / 1000 * field.generated_m2  # same depth integral, over the whole plane
    land = ~(storage.load_raster(spec.aoi_id, "boundary_mask") > 0.5)
    vmax = float(mm.max())
    peak = peak_rate_mm_h(spec)
    out_share = max(0.0, 1 - in_aoi / generated) if generated > 0 else 0.0
    warnings = []
    if peak > PEAK_WARN_MM_H:
        warnings.append(f"peak intensity {peak:.0f} mm/h is above {PEAK_WARN_MM_H:.0f} mm/h; measured 1-hour "
                        "extremes are 133-153 mm/h (Texas, July 2025)")
    if out_share > OUTSIDE_WARN:
        warnings.append(f"{out_share:.0%} of the storm's rain falls outside the model area and is not simulated")
    sp = spec.storm.spatial
    if isinstance(sp, RainCell) and sp.track is not None and sp.track.speed_m_s > 0:
        warnings.append("a moving cell leaves less rain at any point than its centre depth; see max_point_mm")
    if "inflows" in aoi.layers and sp is not None:
        warnings.append("rain upstream of this river area is not simulated; the gauge inflows carry the "
                        "historical event")
    w, s, e, n = g.bounds_wgs84
    return {
        "aoi_id": spec.aoi_id, "bounds_wgs84": [w, s, e, n], "nx": g.nx, "ny": g.ny,
        "png": "data:image/png;base64," + base64.b64encode(png(mm, vmax)).decode(),
        "colour": "#{:02X}{:02X}{:02X}".format(*RAIN_RGB), "max_alpha": MAX_ALPHA, "vmax_mm": round(vmax, 1),
        "max_point_mm": round(vmax, 1),
        "mean_aoi_mm": round(float(mm.mean()), 1), "mean_land_mm": round(float(mm[land].mean()), 1) if land.any() else 0.0,
        "wet_area_km2": round(float((mm >= 1).sum() * cell_m2 / 1e6), 2),
        "volume_generated_m3": round(generated), "volume_in_aoi_m3": round(in_aoi),
        "outside_share": round(out_share, 3), "peak_intensity_mm_h": round(peak, 1),
        "center": list(interventions.cell_center(spec, sp)) if isinstance(sp, RainCell) else None,
        "warnings": warnings,
        "note": "storm total per cell; a cell's total_mm is its centre depth (stationary), a polygon's is the "
                "depth inside it",
    }
