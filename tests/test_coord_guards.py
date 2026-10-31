"""Point routes reject non-finite and out-of-range lon/lat with a 400, before any grid maths (Eng E's API sweep)."""
import os

os.environ.setdefault("DRYRUN_STORAGE", "local")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from dryrun.api.main import app  # noqa: E402
from dryrun.contracts import ScenarioSpec, Storm  # noqa: E402
from dryrun.pipeline import fixtures  # noqa: E402
from dryrun.sim.engine import run_scenario  # noqa: E402

BAD = [("1e308", "6.45"), ("3.49", "-1e308"), ("nan", "6.45"), ("3.49", "inf"), ("181", "6.45"), ("3.49", "-91")]


@pytest.fixture(scope="module")
def run_id(tmp_path_factory):
    from dryrun import storage

    root = tmp_path_factory.mktemp("cg")
    storage.LOCAL_DATA, storage.LOCAL_RUNS = root / "data", root / "runs"
    storage.clear_caches()
    fixtures.build()
    return run_scenario(ScenarioSpec(aoi_id=fixtures.AOI_ID, storm=Storm(total_mm=60, duration_h=1))).run_id


@pytest.mark.parametrize("lon, lat", BAD)
def test_depth_series_point_reject_bad_coords(run_id, lon, lat):
    c = TestClient(app, raise_server_exceptions=False)
    for url in (f"/api/runs/{run_id}/depth?lon={lon}&lat={lat}&t_s=0",
                f"/api/runs/{run_id}/series?lon={lon}&lat={lat}",
                f"/api/aoi/{fixtures.AOI_ID}/point?lon={lon}&lat={lat}"):
        r = c.get(url)
        assert r.status_code == 400, (url, r.status_code, r.text)


def test_depth_still_answers_inside(run_id):
    from dryrun import storage

    w, s, e, n = storage.load_aoi(fixtures.AOI_ID).grid.bounds_wgs84
    r = TestClient(app).get(f"/api/runs/{run_id}/depth?lon={(w + e) / 2}&lat={(s + n) / 2}&t_s=0")
    assert r.status_code == 200
