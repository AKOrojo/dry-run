"""Routing never sends people to a shelter that is itself under water (Eng D)."""

import os

import numpy as np
import pytest

os.environ["DRYRUN_STORAGE"] = "local"
os.environ["DRYRUN_SIM_BACKEND"] = "fake"

from dryrun import storage  # noqa: E402
from dryrun.contracts import RouteRequest, ScenarioSpec, Storm  # noqa: E402
from dryrun.pipeline import fixtures  # noqa: E402
from dryrun.routing import evac  # noqa: E402
from dryrun.sim.engine import run_scenario  # noqa: E402


@pytest.fixture(scope="module")
def run(tmp_path_factory):
    root = tmp_path_factory.mktemp("evac")
    storage.LOCAL_DATA, storage.LOCAL_RUNS = root / "data", root / "runs"
    storage.clear_caches()
    fixtures.build()
    return run_scenario(ScenarioSpec(aoi_id=fixtures.AOI_ID, storm=Storm(total_mm=0, duration_h=1)))


def _route(run, monkeypatch, flooded):
    depth = np.zeros((fixtures.N, fixtures.N), np.float32)
    for r, c in flooded:
        depth[r, c] = 1.0
    monkeypatch.setattr(evac.storage, "load_depth", lambda *_: depth)
    evac.cut_edges.cache_clear()
    return evac.route(RouteRequest(run_id=run.run_id, t_s=0, origin=fixtures.cell_to_lonlat(12, 28)))


def test_dry_shelters_are_used(run, monkeypatch):
    assert _route(run, monkeypatch, []).destination_name == "Shelter A (school)"


def test_flooded_shelter_is_skipped(run, monkeypatch):
    r = _route(run, monkeypatch, [(12, 20)])  # Shelter A's cell under 1 m
    assert r.reachable and r.destination_name == "Shelter B (church)"


def test_all_shelters_flooded_is_unreachable_not_an_error(run, monkeypatch):
    r = _route(run, monkeypatch, [(12, 20), (10, 100)])
    assert not r.reachable and r.path == []
