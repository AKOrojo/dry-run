"""Serve the LightGBM surrogate WITHOUT lightgbm (owner: Eng A).

train.py exports each booster with booster.dump_model() and flattens the trees into arrays; this
module evaluates them with numpy, so the Cloud Run image needs no lightgbm/pandas.
Model file: storage private area, surrogate/<aoi_id>/model.json:
  {"version": 1, "config": AOIConfig, "features": [...], "trained_on": {...},
   "targets": {name: {"trees": [flat tree, ...], "metrics": {"r2": .., "mae": .., "n_test": ..}}}}
Flat tree: {"feature": [int], "threshold": [float], "left": [int], "right": [int],
            "default_left": [bool], "value": [float]}; child index < 0 means leaf ~child.
"""

from __future__ import annotations

import json
from functools import lru_cache

import numpy as np

from dryrun import storage


def model_path(aoi_id: str) -> str:
    return f"surrogate/{aoi_id}/model.json"


def flatten(tree_structure: dict) -> dict:
    """LightGBM dump_model()['tree_info'][i]['tree_structure'] -> flat arrays."""
    feat, thr, left, right, dleft, leaves = [], [], [], [], [], []

    def walk(node) -> int:
        if "leaf_value" in node:
            leaves.append(float(node["leaf_value"]))
            return ~(len(leaves) - 1)
        if node.get("decision_type", "<=") != "<=":
            raise ValueError(f"unsupported split {node.get('decision_type')}")
        i = len(feat)
        feat.append(int(node["split_feature"]))
        thr.append(float(node["threshold"]))
        dleft.append(bool(node.get("default_left", True)))
        left.append(0)
        right.append(0)
        left[i] = walk(node["left_child"])
        right[i] = walk(node["right_child"])
        return i

    walk(tree_structure)
    return {"feature": feat, "threshold": thr, "left": left, "right": right, "default_left": dleft,
            "value": leaves}


def predict_trees(trees: list[dict], X: np.ndarray) -> np.ndarray:
    X = np.atleast_2d(np.asarray(X, np.float64))
    out = np.zeros(len(X))
    for t in trees:
        if not t["feature"]:  # a single-leaf tree
            out += t["value"][0]
            continue
        f, th = np.array(t["feature"]), np.array(t["threshold"])
        lc, rc, dl, val = np.array(t["left"]), np.array(t["right"]), np.array(t["default_left"]), np.array(t["value"])
        node = np.zeros(len(X), int)
        active = np.ones(len(X), bool)
        while active.any():
            idx = np.nonzero(active)[0]
            n = node[idx]
            x = X[idx, f[n]]
            go_left = np.where(np.isnan(x), dl[n], x <= th[n])
            node[idx] = np.where(go_left, lc[n], rc[n])
            active[idx] = node[idx] >= 0
        out += val[~node]
    return out


class Surrogate:
    def __init__(self, blob: dict):
        self.blob = blob
        self.features = blob["features"]
        self.config = blob["config"]

    def predict(self, X) -> dict[str, np.ndarray]:
        X = np.atleast_2d(np.asarray(X, np.float64))
        return {k: np.maximum(predict_trees(v["trees"], X), 0.0) for k, v in self.blob["targets"].items()}

    def metrics(self) -> dict:
        return {k: v["metrics"] for k, v in self.blob["targets"].items()}


@lru_cache(maxsize=4)
def load(aoi_id: str) -> Surrogate:
    """Cached per process: retraining a model needs an instance restart (like AOI ids, treat as immutable)."""
    try:
        raw = storage.read_private(model_path(aoi_id))
    except Exception as exc:  # noqa: BLE001 - missing file in local or GCS mode
        raise ValueError(f"no surrogate model trained for aoi {aoi_id!r}; use run_simulation") from exc
    return Surrogate(json.loads(raw))
