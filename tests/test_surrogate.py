"""Surrogate (Eng A): parameter mapping, numpy tree evaluator, sweep ranking, CSI scoring.

The LightGBM round trip only runs where the `surrogate` extra is installed; CI (dev + sim) still
covers the serving path through a hand-built tree.
"""

import importlib.util
import json
import os
from pathlib import Path

import numpy as np
import pytest

os.environ["DRYRUN_STORAGE"] = "local"

from dryrun import storage  # noqa: E402
from dryrun.contracts import ScenarioSpec, TideLevel  # noqa: E402
from dryrun.surrogate import features as F  # noqa: E402
from dryrun.surrogate import model  # noqa: E402

CFG = F.DEFAULT_CONFIGS["fixture-synthetic"]


@pytest.fixture()
def private(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "LOCAL_DATA", tmp_path / "data")
    model.load.cache_clear()
    yield
    model.load.cache_clear()


def test_latin_hypercube_fills_every_stratum():
    n = 50
    s = F.latin_hypercube(n, seed=3)
    for k, (lo, hi) in F.RANGES.items():
        strata = sorted(int((p[k] - lo) / (hi - lo) * n) for p in s)
        assert strata == list(range(n)), k
    assert s == F.latin_hypercube(n, seed=3)


def test_samples_are_real_scenarios():
    p = {"total_mm": 120, "duration_h": 3, "tide_m": F.DEFAULT_TIDE_M, "drain_factor": 1.0, "add_mm_h": 0,
         "green_mm_h": 2.0, "pond_depth_m": 0.1}
    assert F.scenario(p, CFG).interventions == []  # below thresholds, default tide: baseline
    assert F.feature_row(p)[F.FEATURES.index("green_mm_h")] == 0.0
    p.update(tide_m=1.0, drain_factor=2.0, green_mm_h=30, pond_depth_m=2)
    spec = F.scenario(p, CFG)
    assert [iv.type for iv in spec.interventions] == ["drain_upgrade", "green", "pond", "tide"]
    assert ScenarioSpec.model_validate(spec.model_dump()) == spec


def test_numpy_tree_evaluator():
    # x0 <= 1 ? (x1 <= 5 ? 10 : 20) : 30, NaN on x0 goes right
    tree = {"split_feature": 0, "threshold": 1.0, "decision_type": "<=", "default_left": False,
            "left_child": {"split_feature": 1, "threshold": 5.0, "decision_type": "<=", "default_left": True,
                           "left_child": {"leaf_value": 10.0}, "right_child": {"leaf_value": 20.0}},
            "right_child": {"leaf_value": 30.0}}
    flat = model.flatten(tree)
    X = np.array([[0, 0], [0, 9], [2, 0], [np.nan, 0], [1, 5]])
    assert model.predict_trees([flat, model.flatten({"leaf_value": 1.0})], X).tolist() == [11, 21, 31, 31, 11]


def test_sweep_without_model_is_a_clear_error(private):
    from dryrun.surrogate.sweep import surrogate_sweep

    with pytest.raises(ValueError, match="no surrogate model"):
        surrogate_sweep("fixture-synthetic", 120, 3)


@pytest.mark.skipif(importlib.util.find_spec("lightgbm") is None, reason="needs the surrogate extra")
def test_train_export_and_sweep_ranks_candidates(private):
    from dryrun.surrogate import dataset, train
    from dryrun.surrogate.sweep import surrogate_sweep

    rows = []
    for p in F.latin_hypercube(160, seed=1):  # synthetic response with the right physics signs
        x = F.feature_row(p)
        d = dict(zip(F.FEATURES, x))
        wet = max(d["total_mm"] * (1 + 0.3 * d["tide_m"]) - 25 * d["drain_factor"] - 1.5 * d["add_mm_h"]
                  - 0.4 * d["green_mm_h"] - 8 * d["pond_depth_m"], 0)
        rows.append({"params": p, "x": x, "run_id": "r_x", "backend": "solver", "mass_balance_error_pct": 0.0,
                     "y": {"buildings_flooded": 2 * wet, "buildings_flooded_severe": 0.5 * wet,
                           "people_exposed": 300 * wet, "road_km_impassable": 0.05 * wet,
                           "flooded_area_km2": 0.01 * wet}})
    blob = {"config": F.config_dict(CFG), "features": list(F.FEATURES), "targets": list(F.TARGETS),
            "seed": 0, "n": 160, "shard": 0, "shards": 1, "backend": "solver", "rows": rows}
    storage.write_private(dataset.dataset_path(CFG.aoi_id, 0, 0, 1), json.dumps(blob).encode())
    out = train.train(CFG.aoi_id)  # raises if the numpy export disagrees with lightgbm
    assert out["targets"]["buildings_flooded"]["metrics"]["r2"] > 0.8

    res = surrogate_sweep(CFG.aoi_id, 150, 3, objective="buildings_flooded", top_k=3)
    assert res["is_surrogate"] and len(res["candidates"]) == 3
    preds = [c["predicted"]["buildings_flooded"] for c in res["candidates"]]
    assert preds == sorted(preds) and preds[0] < res["baseline_predicted"]["buildings_flooded"]
    for c in res["candidates"]:  # every candidate can be sent to run_simulation as-is
        spec = ScenarioSpec.model_validate({"aoi_id": CFG.aoi_id, "storm": {"total_mm": 150, "duration_h": 3},
                                            "interventions": c["interventions"]})
        assert not any(isinstance(iv, TideLevel) for iv in spec.interventions)
    assert "warning" in surrogate_sweep(CFG.aoi_id, 400, 3)


def _csi():
    p = Path(__file__).resolve().parents[1] / "evals" / "validation" / "csi.py"
    spec = importlib.util.spec_from_file_location("csi", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_csi_scores():
    sim = np.array([[1, 1, 0, 0], [1, 0, 0, 1]], bool)
    obs = np.array([[1, 0, 1, 0], [1, 0, 0, 1]], bool)
    valid = np.ones_like(sim)
    valid[1, 3] = False  # permanent water: ignored
    s = _csi().scores(sim, obs, valid)
    assert (s["hits"], s["misses"], s["false_alarms"]) == (2, 1, 1)
    assert s["csi"] == 0.5 and s["pod"] == round(2 / 3, 4) and s["cells_compared"] == 7
