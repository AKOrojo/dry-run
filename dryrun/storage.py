"""Storage abstraction (owner: Eng D).

Everything reads/writes through here so the same code runs on a laptop
(DRYRUN_STORAGE=local, folders ./data and ./runs) and on Cloud Run
(DRYRUN_STORAGE=gcs, buckets from env). Nobody else imports google.cloud.storage.
"""

from __future__ import annotations

import io
import json
import os
from functools import lru_cache
from pathlib import Path

import numpy as np

from dryrun.contracts import AOIManifest, RunManifest

MODE = os.getenv("DRYRUN_STORAGE", "local")  # local | gcs
LOCAL_DATA = Path(os.getenv("DRYRUN_DATA_DIR", "data"))
LOCAL_RUNS = Path(os.getenv("DRYRUN_RUNS_DIR", "runs"))
DATA_BUCKET = os.getenv("DRYRUN_DATA_BUCKET", "")  # private: aoi/<aoi_id>/...
RUNS_BUCKET = os.getenv("DRYRUN_RUNS_BUCKET", "")  # public-read: runs/<run_id>/...
PUBLIC_RUNS_BASE = os.getenv("DRYRUN_PUBLIC_RUNS_BASE", "/runs")  # URL prefix the UI uses


# ----------------------------------------------------------------- low level
@lru_cache(maxsize=1)
def _gcs():
    from google.cloud import storage  # imported lazily so local dev needs no GCP libs

    return storage.Client()


def _where(kind: str) -> tuple[Path, str, str]:
    """kind -> (local dir, bucket, object prefix).
    data    : AOI layers                 private bucket, aoi/
    private : agent route results        private bucket, private/
    uploads : user photos/video + masks  private bucket, uploads/   (NEVER the public bucket)
    runs    : model outputs              public-read bucket, runs/
    """
    if kind == "data":
        return LOCAL_DATA, DATA_BUCKET, "aoi/"
    if kind == "uploads":
        return LOCAL_DATA / "_uploads", DATA_BUCKET, "uploads/"
    if kind == "private":  # agent route results etc. (contain user-chosen coordinates)
        return LOCAL_DATA / "_private", DATA_BUCKET, "private/"
    if kind == "runs":
        return LOCAL_RUNS, RUNS_BUCKET, "runs/"
    raise ValueError(kind)


def _read_bytes(kind: str, rel: str) -> bytes:
    local, bucket, prefix = _where(kind)
    if MODE == "local":
        return (local / rel).read_bytes()
    return _gcs().bucket(bucket).blob(prefix + rel).download_as_bytes()


def _write_bytes(kind: str, rel: str, data: bytes, content_type: str) -> None:
    local, bucket, prefix = _where(kind)
    if MODE == "local":
        p = local / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return
    blob = _gcs().bucket(bucket).blob(prefix + rel)
    # Run outputs are immutable (run_id is content-addressed) -> cache forever. NOT manifests:
    # they go running -> done/failed, so they must never be cached.
    immutable = kind == "runs" and not rel.endswith("manifest.json")
    blob.cache_control = "public, max-age=31536000, immutable" if immutable else "no-store"
    blob.upload_from_string(data, content_type=content_type)


def _exists(kind: str, rel: str) -> bool:
    local, bucket, prefix = _where(kind)
    if MODE == "local":
        return (local / rel).exists()
    return _gcs().bucket(bucket).blob(prefix + rel).exists()


# --------------------------------------------------------------------- AOI
@lru_cache(maxsize=8)
def load_aoi(aoi_id: str) -> AOIManifest:
    return AOIManifest.model_validate_json(_read_bytes("data", f"{aoi_id}/manifest.json"))


@lru_cache(maxsize=8)
def aoi_hash(aoi_id: str) -> str:
    import hashlib

    return hashlib.sha256(_read_bytes("data", f"{aoi_id}/manifest.json")).hexdigest()[:12]


@lru_cache(maxsize=64)
def load_raster(aoi_id: str, layer: str) -> np.ndarray:
    """Returns float32 [ny, nx] from a .npy layer (the only raster format on the serving path)."""
    rel = f"{aoi_id}/{load_aoi(aoi_id).layers[layer]}"
    if not rel.endswith(".npy"):
        raise ValueError(f"{layer}: serving rasters must be .npy (got {rel})")
    arr = np.load(io.BytesIO(_read_bytes("data", rel)))
    return arr.astype(np.float32, copy=False)


def load_aoi_file(aoi_id: str, layer: str) -> bytes:
    return _read_bytes("data", f"{aoi_id}/{load_aoi(aoi_id).layers[layer]}")


def write_aoi_file(aoi_id: str, rel: str, data: bytes, content_type="application/octet-stream"):
    _write_bytes("data", f"{aoi_id}/{rel}", data, content_type)


# -------------------------------------------------------------------- runs
def run_exists(run_id: str) -> bool:
    return _exists("runs", f"{run_id}/manifest.json")


def load_run(run_id: str) -> RunManifest:
    return RunManifest.model_validate_json(_read_bytes("runs", f"{run_id}/manifest.json"))


def save_run(manifest: RunManifest) -> None:
    _write_bytes(
        "runs", f"{manifest.run_id}/manifest.json",
        manifest.model_dump_json(indent=2).encode(), "application/json",
    )


def write_run_file(run_id: str, rel: str, data: bytes, content_type: str) -> None:
    _write_bytes("runs", f"{run_id}/{rel}", data, content_type)


def read_run_file(run_id: str, rel: str) -> bytes:
    return _read_bytes("runs", f"{run_id}/{rel}")


@lru_cache(maxsize=128)  # safe: run outputs are immutable
def load_depth(run_id: str, rel: str) -> np.ndarray:
    return np.load(io.BytesIO(_read_bytes("runs", f"{run_id}/{rel}"))).astype(np.float32)


def write_private(rel: str, data: bytes, content_type: str = "application/json") -> None:
    _write_bytes("private", rel, data, content_type)


def read_private(rel: str) -> bytes:
    return _read_bytes("private", rel)


def clear_caches() -> None:
    """Drop in-memory AOI caches (e.g. after publishing a NEW aoi id). AOI ids are immutable."""
    load_aoi.cache_clear()
    load_raster.cache_clear()
    aoi_hash.cache_clear()
    from dryrun.sim import exposure

    exposure.clear_caches()
    from dryrun.routing import evac

    evac._node_index.cache_clear()
    evac._run_masks.cache_clear()
    evac.cut_edges.cache_clear()


def write_upload(rel: str, data: bytes, content_type: str) -> None:
    """Eng C: user uploads (photos, video, masks) -> PRIVATE storage only."""
    _write_bytes("uploads", rel, data, content_type)


def read_upload(rel: str) -> bytes:
    return _read_bytes("uploads", rel)


def public_run_url(run_id: str, rel: str) -> str:
    return f"{PUBLIC_RUNS_BASE.rstrip('/')}/{run_id}/{rel}"


def dumps(obj) -> bytes:
    return json.dumps(obj, indent=2).encode()
