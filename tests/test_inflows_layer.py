"""The Texas river sources reach the UI as GeoJSON points with their hydrographs."""

import os
from types import SimpleNamespace

os.environ.setdefault("DRYRUN_STORAGE", "local")

from dryrun.api.main import _inflows_geojson  # noqa: E402


def test_points_from_entry_cells():
    grid = SimpleNamespace(bounds_wgs84=[-100.0, 30.0, -99.0, 31.0], nx=10, ny=10)
    raw = {"t0_utc": "2025-07-04T06:00", "note": "n",
           "sources": [{"name": "A", "gauges": {"2": [1, 0], "1": [1, 0]}, "cells": [[0, 0], [0, 2]],
                        "hydrograph": [[0.0, 1.0], [300.0, 2.0]]}]}
    fc = _inflows_geojson(SimpleNamespace(grid=grid), raw)
    (f,) = fc["features"]
    assert f["geometry"]["coordinates"] == [-99.85, 30.95]  # mean col 1 -> centre 1.5/10; row 0 -> 0.5/10 from N
    assert f["properties"]["gauges"] == ["1", "2"] and f["properties"]["hydrograph"][1] == [300.0, 2.0]
    assert fc["properties"]["t0_utc"] == "2025-07-04T06:00"


def test_no_sources():
    grid = SimpleNamespace(bounds_wgs84=[0, 0, 1, 1], nx=1, ny=1)
    assert _inflows_geojson(SimpleNamespace(grid=grid), {})["features"] == []
