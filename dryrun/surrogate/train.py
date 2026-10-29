"""LightGBM surrogate (owner: Eng A, Day 4-5). Needs the `surrogate` extra; batch only.

Data: dataset.py (Latin hypercube of real solver runs, see features.RANGES).
Targets: features.TARGETS (RunStats fields). One LightGBM regressor per target.
Metrics: 5-fold cross-validated R^2 / MAE (reported in the README model card and returned by
surrogate_sweep); the served model is then refit on all rows. Exported with dump_model() and
flattened for model.py's numpy evaluator, so serving needs no lightgbm.
Surrogate results carry is_surrogate=True and the agent must confirm any recommendation with a
real run_simulation before citing it.

  python -m dryrun.surrogate.train --aoi fixture-synthetic --shards 1 [--seed 0]
"""

from __future__ import annotations

import argparse
import json

import numpy as np

from dryrun import storage
from dryrun.surrogate import dataset, model

PARAMS = dict(objective="regression", learning_rate=0.05, num_leaves=15, min_data_in_leaf=5,
              bagging_fraction=0.9, bagging_freq=1, feature_fraction=0.9, lambda_l2=1.0, deterministic=True,
              force_row_wise=True, num_threads=1, verbose=-1)  # tiny data: threads only add overhead
ROUNDS = 400


def load_rows(aoi_id: str, seed: int, shards: int) -> tuple[dict, list[dict]]:
    meta, rows = None, []
    for i in range(shards):
        blob = json.loads(storage.read_private(dataset.dataset_path(aoi_id, seed, i, shards)))
        meta = meta or blob
        rows += [r for r in blob["rows"] if "error" not in r]
    return meta, rows


def _fit(X, y, seed):
    import lightgbm as lgb  # native API: the sklearn wrapper would also need scikit-learn

    return lgb.train({**PARAMS, "seed": seed}, lgb.Dataset(X, y), num_boost_round=ROUNDS)


def cv_metrics(X: np.ndarray, y: np.ndarray, folds: int = 5, seed: int = 0) -> dict:
    idx = np.random.default_rng(seed).permutation(len(y))
    pred = np.zeros(len(y))
    for k in range(folds):
        test = idx[k::folds]
        train = np.setdiff1d(idx, test)
        pred[test] = np.maximum(_fit(X[train], y[train], seed).predict(X[test]), 0)
    ss = float(((y - y.mean()) ** 2).sum())
    return {"r2": round(1 - float(((y - pred) ** 2).sum()) / ss, 4) if ss > 0 else None,
            "mae": round(float(np.abs(y - pred).mean()), 4), "n": int(len(y)), "folds": folds}


def train(aoi_id: str, seed: int = 0, shards: int = 1) -> dict:
    meta, rows = load_rows(aoi_id, seed, shards)
    X = np.array([r["x"] for r in rows], np.float64)
    out = {"version": 1, "config": meta["config"], "features": meta["features"],
           "trained_on": {"n": len(rows), "backend": meta["backend"], "seed": seed,
                          "max_abs_mass_balance_error_pct": max(abs(r["mass_balance_error_pct"]) for r in rows)},
           "targets": {}}
    for t in meta["targets"]:
        y = np.array([r["y"][t] for r in rows], np.float64)
        booster = _fit(X, y, seed)
        trees = [model.flatten(ti["tree_structure"]) for ti in booster.dump_model()["tree_info"]]
        check = model.predict_trees(trees, X)
        if not np.allclose(check, booster.predict(X), rtol=1e-6, atol=1e-6):
            raise RuntimeError(f"{t}: numpy evaluator disagrees with lightgbm")
        out["targets"][t] = {"trees": trees, "metrics": cv_metrics(X, y, seed=seed)}
    storage.write_private(model.model_path(aoi_id), json.dumps(out).encode())
    model.load.cache_clear()
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--aoi", required=True)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--shards", type=int, default=1)
    a = ap.parse_args()
    out = train(a.aoi, a.seed, a.shards)
    print(f"trained on {out['trained_on']['n']} runs ({out['trained_on']['backend']})")
    for t, v in out["targets"].items():
        print(f"  {t:26s} R2={v['metrics']['r2']}  MAE={v['metrics']['mae']}")


if __name__ == "__main__":
    main()
