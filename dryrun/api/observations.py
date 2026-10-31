"""Stored flood observations (POST /api/observe, Eng C) listed per AOI for the map pins.

Only the Observation record goes out: the anonymised photo stays private in uploads/, and mask_png points at the
existing mask route.
"""
from __future__ import annotations

import time

from dryrun import storage
from dryrun.contracts import Observation

MAX_LISTED = 200
CACHE_S = 30

# (time listed, every stored observation). One storage listing per instance per 30 s, whatever the traffic.
_CACHE: tuple[float, list[Observation]] = (0.0, [])


def _all() -> list[Observation]:
    global _CACHE
    if time.time() - _CACHE[0] < CACHE_S:
        return _CACHE[1]
    out = []
    for rel in storage.list_rel("uploads", "observations/"):
        if not rel.endswith("/observation.json"):
            continue
        try:
            out.append(Observation.model_validate_json(storage.read_upload(rel)))
        except Exception:  # noqa: BLE001 - one bad or half-written record must not hide the rest
            continue
    out.sort(key=lambda o: o.obs_id)
    _CACHE = (time.time(), out)
    return out


def list_for_aoi(aoi_id: str, run_id: str | None = None) -> list[dict]:
    w, s, e, n = storage.load_aoi(aoi_id).grid.bounds_wgs84
    inside = [o for o in _all() if w <= o.lon <= e and s <= o.lat <= n][:MAX_LISTED]
    if run_id is None:
        return [o.model_dump() for o in inside]
    from dryrun.meta.observe import _sim_depth  # heavy imports (PIL, SAM parser): only when a run is asked for

    return [o.model_copy(update={"sim_depth_m": _sim_depth(run_id, o.lon, o.lat)}).model_dump() for o in inside]
