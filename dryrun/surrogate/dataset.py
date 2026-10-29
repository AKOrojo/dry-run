"""Surrogate training set: Latin hypercube of solver runs (owner: Eng A).

BATCH ONLY (Modal / a Cloud Run Job / a laptop), never the live API. Runs go through
engine.run_scenario, so every sample is a real, cached, content-addressed run (and the solver is
deterministic, so re-running a shard is free). Shard across job tasks with --shard i/k; each shard
writes its own file, train.py merges them.

  DRYRUN_SIM_BACKEND=solver python -m dryrun.surrogate.dataset --aoi fixture-synthetic --n 300 --workers 4
Output (storage private area): surrogate/<aoi>/dataset-<seed>-<i>of<k>.json
"""

from __future__ import annotations

import argparse
import json
import os
from concurrent.futures import ProcessPoolExecutor

from dryrun import storage
from dryrun.surrogate import features as F


def dataset_path(aoi_id: str, seed: int, shard: int, shards: int) -> str:
    return f"surrogate/{aoi_id}/dataset-{seed}-{shard}of{shards}.json"


def _one(args) -> dict:
    p, cfg = args
    from dryrun.sim.engine import run_scenario

    m = run_scenario(F.scenario(p, cfg))
    if m.stats is None:
        return {"params": p, "error": m.error}
    return {"params": p, "x": F.feature_row(p), "run_id": m.run_id, "backend": m.backend,
            "y": {t: getattr(m.stats, t) for t in F.TARGETS},
            "mass_balance_error_pct": m.stats.mass_balance_error_pct}


def generate(cfg: F.AOIConfig, n: int, seed: int = 0, shard: int = 0, shards: int = 1, workers: int = 1,
             allow_fake: bool = False) -> list[dict]:
    from dryrun.sim import BACKEND

    if BACKEND != "solver" and not allow_fake:
        raise RuntimeError("surrogate data must come from the real solver: set DRYRUN_SIM_BACKEND=solver")
    samples = F.latin_hypercube(n, seed)[shard::shards]
    jobs = [(p, cfg) for p in samples]
    if workers > 1:
        with ProcessPoolExecutor(workers) as ex:
            rows = list(ex.map(_one, jobs))
    else:
        rows = [_one(j) for j in jobs]
    blob = {"config": F.config_dict(cfg), "features": list(F.FEATURES), "targets": list(F.TARGETS),
            "seed": seed, "n": n, "shard": shard, "shards": shards, "backend": BACKEND, "rows": rows}
    storage.write_private(dataset_path(cfg.aoi_id, seed, shard, shards), json.dumps(blob).encode())
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--aoi", required=True)
    ap.add_argument("--green-place")
    ap.add_argument("--pond-place")
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--shard", default=os.getenv("CLOUD_RUN_TASK_INDEX", "0") + "/" +
                    os.getenv("CLOUD_RUN_TASK_COUNT", "1"), help="i/k")
    ap.add_argument("--workers", type=int, default=1)
    a = ap.parse_args()
    cfg = F.DEFAULT_CONFIGS.get(a.aoi)
    if a.green_place or a.pond_place or cfg is None:
        if not (a.green_place and a.pond_place):
            raise SystemExit("give --green-place and --pond-place (names from the AOI's places layer)")
        cfg = F.AOIConfig(a.aoi, a.green_place, a.pond_place)
    i, k = map(int, a.shard.split("/"))
    rows = generate(cfg, a.n, a.seed, i, k, a.workers)
    bad = [r for r in rows if "error" in r]
    print(f"{len(rows) - len(bad)} runs ok, {len(bad)} failed -> {dataset_path(cfg.aoi_id, a.seed, i, k)}")


if __name__ == "__main__":
    main()
