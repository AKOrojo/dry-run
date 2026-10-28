"""FastAPI service: the ONLY backend the browser talks to (shell owner: Eng D).

One Cloud Run service serves:  /api/*  (JSON + SSE + WS)  and  /  (built web/dist).
Run outputs are served from the public runs bucket in prod, from ./runs locally.

Endpoint owners:  simulate/runs/depth = A   route/aoi/config/health/compare = D
                  agent/observe/render/voice = C          web/dist = B
"""

from __future__ import annotations

import json
import math
import os
import re
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from dryrun import storage
from dryrun.api.ratelimit import limit  # noqa: E402
from dryrun.contracts import (
    CONTRACT_VERSION,
    AOIManifest,
    CompareResult,
    RouteRequest,
    RouteResult,
    RunManifest,
    ScenarioSpec,
)
from dryrun.routing.evac import route as compute_route
from dryrun.sim import BACKEND as SIM_BACKEND
from dryrun.sim.engine import run_scenario

ADMIN_TOKEN = "" if os.getenv("DRYRUN_ADMIN_TOKEN", "").strip() == "unset" else os.getenv("DRYRUN_ADMIN_TOKEN", "")
app = FastAPI(title="Dry Run API", version=CONTRACT_VERSION)

RUN_ID = re.compile(r"^r_[0-9a-f]{16}$")
AOI_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


@app.exception_handler(ValueError)
async def _bad_request(_request: Request, exc: ValueError):
    # Domain errors (unknown place, point off the road network, bad ids) are the caller's fault: 400.
    return JSONResponse({"detail": str(exc)}, status_code=400)


def _check_run(run_id: str) -> None:
    if not RUN_ID.match(run_id):
        raise HTTPException(400, "bad run_id")
    if not storage.run_exists(run_id):
        raise HTTPException(404, "run not found")


def _check_aoi(aoi_id: str) -> None:
    if not AOI_ID.match(aoi_id):
        raise HTTPException(400, "bad aoi_id")
    try:
        storage.load_aoi(aoi_id)
    except Exception as exc:  # noqa: BLE001 - missing file / GCS NotFound
        raise HTTPException(404, f"unknown AOI {aoi_id}") from exc
# The browser only ever talks to this one origin in prod -- this service serves the web app too --
# so CORS exists purely for `vite dev` on :5173. Default to that ONLY when running locally.
# Carrying the allowance into prod lets any page on any developer's machine drive the live API
# from a visitor's browser, which buys nothing there.
_cors_default = "http://localhost:5173" if storage.MODE == "local" else ""
_origins = [o for o in os.getenv("CORS_ORIGINS", _cors_default).split(",") if o.strip()]
if _origins:
    app.add_middleware(CORSMiddleware, allow_origins=_origins, allow_methods=["*"], allow_headers=["*"])

# Frames and manifests load straight from the public runs bucket, so its origin must be allowed.
# Derived from the configured base rather than hardcoded, so changing bucket or region cannot
# silently blank the globe. Local mode uses a relative "/runs" and contributes no origin.
_p = urlparse(storage.PUBLIC_RUNS_BASE)
_runs_origin = f"{_p.scheme}://{_p.netloc}" if _p.scheme and _p.netloc else ""
_CESIUM = "https://api.cesium.com https://assets.ion.cesium.com https://*.cesium.com"
# Globe.tsx falls back to OpenStreetMap raster tiles whenever no Cesium ion token is configured,
# which is the default state of a fresh deploy -- so this is the basemap the demo actually shows,
# not an optional extra. Omitting it costs 45 blocked requests and a black globe.
_BASEMAP = "https://tile.openstreetmap.org"
# 'unsafe-eval' is here because CesiumJS requires it, not because it is acceptable. Its widget
# layer evaluates strings as JavaScript, and without it the bundle throws EvalError during module
# init and the page renders completely blank -- measured in a real browser, not assumed. That
# costs us CSP's main anti-XSS guarantee, so treat it as a reason to be stricter about escaping
# in the UI, not a reason to relax. What the policy still buys is worth keeping: frame-ancestors
# blocks clickjacking, object-src kills plugin embedding, base-uri stops <base> hijacking, and
# connect-src/img-src bound where any injected code could send data. 'wasm-unsafe-eval' stays for
# the Draco and KTX2 decoders; blob: for Cesium's workers; inline styles for its widgets.
# If Cesium ever drops its eval dependency, remove 'unsafe-eval' and re-test the globe.
CSP = "; ".join(" ".join(part.split()) for part in [
    "default-src 'self'",
    "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    f"img-src 'self' data: blob: {_runs_origin} {_CESIUM} {_BASEMAP}",
    f"connect-src 'self' {_runs_origin} {_CESIUM} {_BASEMAP}",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
])


@app.middleware("http")
async def security_headers(request: Request, call_next):
    """Baseline response headers -- Cloud Run adds none of these for you."""
    resp = await call_next(request)
    resp.headers.setdefault("Content-Security-Policy", CSP)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    # strict-origin-when-cross-origin, NOT no-referrer. OpenStreetMap's tile usage policy
    # requires an app to identify itself, and no-referrer strips the only thing identifying us:
    # every tile came back as the 6987-byte "Access blocked" image, served with HTTP 200 so
    # nothing in the logs or status codes showed a problem -- only the rendered pixels did.
    # This sends the bare origin cross-site (no path, no query, HTTPS->HTTP suppressed), which
    # leaks nothing about which run or scenario a user is looking at.
    resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    # frame-ancestors covers this for modern browsers; kept for the ones that ignore CSP.
    resp.headers.setdefault("X-Frame-Options", "DENY")
    # Cloud Run is HTTPS-only, so this cannot lock anyone out of a working http:// path.
    resp.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return resp


# NOT /healthz: Cloud Run reserves some paths ending in "z" at its front end.
@app.get("/api/health")
def health():
    return {"ok": True, "contract": CONTRACT_VERSION}


@app.get("/api/config")
def config():
    return {"contract": CONTRACT_VERSION, "storage": storage.MODE,
            "sim_backend": SIM_BACKEND,
            "runs_base": storage.PUBLIC_RUNS_BASE,
            # Runtime config for the web app (no rebuild needed to switch AOI/provider):
            "default_aoi": os.getenv("DRYRUN_DEFAULT_AOI", "fixture-synthetic"),
            "agent_provider": os.getenv("DRYRUN_AGENT_PROVIDER", "fake"),
            "sovereign_provider_available": bool(_secret("BASETEN_API_KEY")),
            # Cesium ion tokens are public client tokens (restrict allowed URLs in the ion dashboard);
            # serving it at runtime keeps it out of the image and out of Cloud Build secrets.
            "cesium_ion_token": _secret("CESIUM_ION_TOKEN"),
            # Optional: large footprint file served gzipped from the public bucket (or ion). Empty = use
            # /api/aoi/{id}/layer/buildings_geojson.
            "buildings_url": os.getenv("DRYRUN_BUILDINGS_URL", "")}


def _secret(name: str) -> str:
    """Bootstrap seeds secrets with the placeholder 'unset': treat that as empty."""
    v = os.getenv(name, "").strip()
    return "" if v == "unset" else v


@app.post("/admin/reload")
def reload_caches(x_admin_token: str = Header("")):
    """Drop in-memory AOI caches on THIS instance. Normally unnecessary: AOI ids are immutable."""
    if not ADMIN_TOKEN or x_admin_token != ADMIN_TOKEN:
        raise HTTPException(403, "forbidden")
    storage.clear_caches()
    return {"ok": True}


@app.get("/api/aoi/{aoi_id}", response_model=AOIManifest)
def get_aoi(aoi_id: str):
    _check_aoi(aoi_id)
    return storage.load_aoi(aoi_id)


@app.post("/api/simulate", response_model=RunManifest)
def simulate(spec: ScenarioSpec, request: Request):
    # Sync endpoint -> FastAPI runs it in a threadpool. Fine at demo scale (seconds/run).
    limit(request, "simulate", per_hour=60)  # cached runs are cheap; uncached cost CPU
    _check_aoi(spec.aoi_id)  # before run_id(), which hashes the AOI manifest
    return run_scenario(spec)


@app.get("/api/runs/{run_id}", response_model=RunManifest)
def get_run(run_id: str):
    _check_run(run_id)
    return storage.load_run(run_id)


@app.get("/api/runs/{run_id}/depth")
def depth_at(run_id: str, lon: float, lat: float, t_s: int):
    _check_run(run_id)
    m = storage.load_run(run_id)
    if not m.frames:
        raise HTTPException(409, f"run is {m.status.value}")
    g = storage.load_aoi(m.scenario.aoi_id).grid
    w, s, e, n = g.bounds_wgs84
    col, row = math.floor((lon - w) / (e - w) * g.nx), math.floor((n - lat) / (n - s) * g.ny)
    if not (0 <= row < g.ny and 0 <= col < g.nx):
        raise HTTPException(400, "point outside AOI")
    f = min(m.frames, key=lambda fr: abs(fr.t_s - t_s))
    d = storage.load_depth(run_id, f.depth)
    return {"run_id": run_id, "t_s": f.t_s, "depth_m": round(float(d[row, col]), 3),
            "max_depth_m": round(float(storage.load_depth(run_id, "max_depth.npy")[row, col]), 3)}


@app.post("/api/route", response_model=RouteResult)
def route(req: RouteRequest, request: Request):
    limit(request, "route", per_hour=600)
    _check_run(req.run_id)
    return compute_route(req)


@app.get("/api/aoi/{aoi_id}/layer/{layer}")
def aoi_vector_layer(aoi_id: str, layer: str):
    _check_aoi(aoi_id)
    """Vector layers for the globe. Large footprint sets may instead be served gzipped from the
    public bucket or Cesium ion (see doc 04)."""
    if layer not in {"buildings_geojson", "shelters", "places"}:
        raise HTTPException(404, "not a public vector layer")
    m = storage.load_aoi(aoi_id)
    rel = m.layers.get(layer)
    if not rel or not rel.endswith(".geojson"):
        raise HTTPException(404, f"{layer} has no GeoJSON form for this AOI")
    return Response(storage.load_aoi_file(aoi_id, layer), media_type="application/geo+json",
                    headers={"Cache-Control": "public, max-age=3600"})


@app.get("/api/compare", response_model=CompareResult)
def compare(base_run_id: str, alt_run_id: str):
    from dryrun.agent.tools import dispatch

    _check_run(base_run_id)
    _check_run(alt_run_id)
    return dispatch("compare_runs", json.dumps({"base_run_id": base_run_id, "alt_run_id": alt_run_id}))


# Eng C endpoints live in their own router to avoid merge conflicts.
from dryrun.api.agent_routes import router as agent_router  # noqa: E402
from dryrun.api.render_routes import router as render_router  # noqa: E402

app.include_router(agent_router)
app.include_router(render_router)


# ---- static: run outputs (local mode only) and the built frontend ----
if storage.MODE == "local":
    storage.LOCAL_RUNS.mkdir(parents=True, exist_ok=True)
    app.mount("/runs", StaticFiles(directory=storage.LOCAL_RUNS), name="runs")
_dist = Path(os.getenv("DRYRUN_WEB_DIST", "web/dist"))
if _dist.exists():
    app.mount("/", StaticFiles(directory=_dist, html=True), name="web")
