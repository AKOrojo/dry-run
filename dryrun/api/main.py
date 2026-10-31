"""FastAPI service: the ONLY backend the browser talks to (shell owner: Eng D).

One Cloud Run service serves:  /api/*  (JSON + SSE + WS)  and  /  (built web/dist).
Run outputs are served from the public runs bucket in prod, from ./runs locally.

Endpoint owners:  simulate/runs/depth = A   route/aoi/config/health/compare = D
                  agent/observe/render/voice = C          web/dist = B
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from dryrun import storage
from dryrun.api import ratelimit  # noqa: E402
from dryrun.api.errors import error_body  # noqa: E402
from dryrun.api.ratelimit import limit  # noqa: E402
from dryrun.api.static import PrecompressedStatic  # noqa: E402
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
from dryrun.sim import exposure, interventions
from dryrun.sim.engine import run_scenario

ADMIN_TOKEN = "" if os.getenv("DRYRUN_ADMIN_TOKEN", "").strip() == "unset" else os.getenv("DRYRUN_ADMIN_TOKEN", "")
log = logging.getLogger("dryrun.api")


def warm_start(aoi_id: str) -> dict:
    """Do the first-request work at container start: the numba compile (or cache load), the default AOI's
    rasters, roads and building index. A cold first run measured 136 s in prod against 35 s warm; with this,
    43 s. Never raises: a bad AOI must not break the app."""
    took = {}
    steps = [("rasters", lambda: [storage.load_raster(aoi_id, k) for k in (
                 "dem", "manning", "infiltration_mm_h", "drain_sink_mm_h", "boundary_mask", "exclude_mask",
                 "population")]),
             ("roads", lambda: exposure.edge_arrays(aoi_id)), ("buildings", lambda: exposure.building_cells(aoi_id)),
             ("series", lambda: _preload_series(aoi_id))]
    if SIM_BACKEND == "solver":
        from dryrun.sim import solver

        steps.insert(0, ("numba", solver.warmup))
    for name, step in steps:
        t = time.time()
        try:
            step()
            took[name] = round(time.time() - t, 2)
        except Exception as exc:  # noqa: BLE001  (log and keep booting)
            took[name] = f"failed: {type(exc).__name__}: {exc}"
    log.warning("warm_start %s %s", aoi_id, took)  # WARNING so it shows in Cloud Run logs by default
    return took


def _preload_series(aoi_id: str) -> None:
    """The demo's first hover lands on the AOI's first preset (its baseline): load that run's frame stack and
    exclude mask now, so the first hover doesn't pay several seconds. Skipped if the run isn't warmed yet."""
    from dryrun import derived, presets

    w, s_, e, n = storage.load_aoi(aoi_id).grid.bounds_wgs84  # an unknown AOI fails here, like the other steps
    spec = next((s for s in presets.demo()["scenarios"] if s["aoi_id"] == aoi_id), None)
    if spec is None:
        return
    run_id = ScenarioSpec.model_validate(spec).run_id()
    if storage.run_exists(run_id) and storage.load_run(run_id).status.value == "done":
        derived.series(run_id, (w + e) / 2, (s_ + n) / 2)


@asynccontextmanager
async def lifespan(_app):
    # In a background thread, NOT blocking startup: measured 48-98 s at boot in prod, and blocking would make
    # even cached requests on a cold instance wait for it. The first uncached run still benefits.
    if os.getenv("DRYRUN_WARM_ON_START") == "1":  # set by deploy.sh; tests and local dev skip it
        aoi = os.getenv("DRYRUN_DEFAULT_AOI", "fixture-synthetic")
        threading.Thread(target=warm_start, args=(aoi,), name="warm_start", daemon=True).start()
    yield


app = FastAPI(title="Dry Run API", version=CONTRACT_VERSION, lifespan=lifespan)
# JSON and GeoJSON responses. It skips text/event-stream (buffering would hold back the simulate and agent streams)
# and anything that already has a Content-Encoding (the precompressed frontend files).
app.add_middleware(GZipMiddleware, minimum_size=1024)

RUN_ID = re.compile(r"^r_[0-9a-f]{16}$")
AOI_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


@app.exception_handler(ValueError)
async def _bad_request(_request: Request, exc: ValueError):
    # Domain errors (unknown place, point off the road network, bad ids) are the caller's fault: 400.
    return JSONResponse(error_body(400, str(exc)), status_code=400)


@app.exception_handler(StarletteHTTPException)
async def _http_error(_request: Request, exc: StarletteHTTPException):
    headers = dict(exc.headers or {})
    if exc.status_code == 429:
        headers.setdefault("Retry-After", "60")
    return JSONResponse(error_body(exc.status_code, exc.detail), status_code=exc.status_code, headers=headers or None)


@app.exception_handler(RequestValidationError)
async def _invalid_input(_request: Request, exc: RequestValidationError):
    errs = exc.errors()
    first = errs[0] if errs else {}
    where = ".".join(str(p) for p in first.get("loc", ()) if p != "body")
    body = error_body(422, errs)
    body["error"]["message"] = f"invalid request: {where + ' ' if where else ''}{first.get('msg', '')}".strip()
    return JSONResponse(jsonable_encoder(body), status_code=422)


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
# With a token, Cesium ion's default base layer is Bing Aerial: metadata from dev.virtualearth.net, tiles from
# ecn.t*.tiles.virtualearth.net. Without these the ground renders black under the buildings (seen on rev 00031).
_BING = "https://dev.virtualearth.net https://*.virtualearth.net"
# Google Photorealistic 3D Tiles (ion asset 2275207, stretch goal): ion hands out tile.googleapis.com URLs.
_GOOGLE_3D = "https://tile.googleapis.com"
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
    f"img-src 'self' data: blob: {_runs_origin} {_CESIUM} {_BASEMAP} {_BING} {_GOOGLE_3D}",
    f"connect-src 'self' {_runs_origin} {_CESIUM} {_BASEMAP} {_BING} {_GOOGLE_3D}",
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


# Old AOI id -> the id that replaces it. Old ids stay published (old runs, replays and ?run= links need them); the UI
# sends an old ?aoi= without ?run= to the successor. A successor is only offered once it is published.
AOI_SUCCESSORS = {"lagos-lekki-v1": "lagos-lekki-v3", "lagos-lekki-v2": "lagos-lekki-v3", "nyc-queens-v0": "nyc-queens-v1"}


_SUCC_CACHE: tuple[float, dict[str, str]] = (0.0, {})


def _aoi_successors() -> dict[str, str]:
    """Cached for a minute: /api/config is on every page load, and an unpublished id would cost a storage miss."""
    global _SUCC_CACHE
    if time.time() - _SUCC_CACHE[0] < 60:
        return _SUCC_CACHE[1]
    out = {}
    for old, new in AOI_SUCCESSORS.items():
        try:
            storage.load_aoi(new)
        except Exception:  # noqa: BLE001 - not published yet
            continue
        out[old] = new
    _SUCC_CACHE = (time.time(), out)
    return out


@app.get("/api/config")
def config():
    return {"contract": CONTRACT_VERSION, "storage": storage.MODE,
            "sim_backend": SIM_BACKEND,
            "runs_base": storage.PUBLIC_RUNS_BASE,
            # Runtime config for the web app (no rebuild needed to switch AOI/provider):
            "default_aoi": os.getenv("DRYRUN_DEFAULT_AOI", "fixture-synthetic"),
            "agent_provider": os.getenv("DRYRUN_AGENT_PROVIDER", "fake"),
            # Sovereign mode = Muse Spark Open, via OpenRouter (prod) or Baseten (hackathon partner, pending approval).
            "sovereign_provider_available": bool(_secret("OPENROUTER_API_KEY") or _secret("BASETEN_API_KEY")),
            # Paid providers need X-Judge-Key (or the team token): the UI shows a key box when this is true.
            "judge_key_required": ratelimit.paid_access_configured(),
            # Cesium ion tokens are public client tokens (restrict allowed URLs in the ion dashboard);
            # serving it at runtime keeps it out of the image and out of Cloud Build secrets.
            "cesium_ion_token": _secret("CESIUM_ION_TOKEN"),
            # Our own Google Map Tiles key (2D satellite as an alternative to Bing). Judges only: the key itself comes
            # from /api/tiles/google-key behind X-Judge-Key; this flag only says whether to offer the option.
            "google_tiles_available": bool(_secret("GOOGLE_TILES_KEY")),
            # Optional: large footprint file served gzipped from the public bucket (or ion). Empty = use
            # /api/aoi/{id}/layer/buildings_geojson.
            "buildings_url": os.getenv("DRYRUN_BUILDINGS_URL", ""),
            # Superseded AOI ids -> their replacement (only published ones): follow it for ?aoi= links without ?run=.
            "aoi_successors": _aoi_successors()}


@app.get("/api/tiles/google-key")
def google_tiles_key(request: Request):
    """The Google Map Tiles key, for judges and the team only (owner rule). The key is restricted to the Map
    Tiles API and our referrers, and the project caps it to the free tier per day (2D 3,000 tiles)."""
    key = _secret("GOOGLE_TILES_KEY")
    if not key:
        raise HTTPException(404, "Google tiles are not configured")
    ratelimit.require_paid_access(request)
    limit(request, "google_key", per_hour=60)
    return JSONResponse({"key": key}, headers={"Cache-Control": "no-store"})


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
    if not interventions.in_window(m.scenario, g, row, col):  # domain rain_area: not modelled here
        return {"run_id": run_id, "t_s": f.t_s, "in_domain": False, "depth_m": None, "max_depth_m": None}
    d = storage.load_depth(run_id, f.depth)
    return {"run_id": run_id, "t_s": f.t_s, "in_domain": True, "depth_m": round(float(d[row, col]), 3),
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
    if layer not in {"buildings_geojson", "shelters", "places", "inflows", "drains_geojson"}:
        raise HTTPException(404, "not a public vector layer")
    m = storage.load_aoi(aoi_id)
    rel = m.layers.get(layer)
    if layer == "inflows" and rel:
        return Response(json.dumps(_inflows_geojson(m, json.loads(storage.load_aoi_file(aoi_id, layer)))),
                        media_type="application/geo+json", headers={"Cache-Control": "public, max-age=3600"})
    if not rel or not rel.endswith(".geojson"):
        raise HTTPException(404, f"{layer} has no GeoJSON form for this AOI")
    return Response(storage.load_aoi_file(aoi_id, layer), media_type="application/geo+json",
                    headers={"Cache-Control": "public, max-age=3600"})


def _inflows_geojson(m, raw: dict) -> dict:
    """River sources as points: the mean centre of each source's entry cells, plus its gauge hydrograph
    ([t_s, m3/s] from t0_utc) for the UI's sparkline. Cell (r, c) spans [r, r+1) x [c, c+1) from the NW corner."""
    w, s_, e, n = m.grid.bounds_wgs84
    feats = []
    for src in raw.get("sources", []):
        rows, cols = zip(*src["cells"])
        lon = w + (sum(cols) / len(cols) + 0.5) / m.grid.nx * (e - w)
        lat = n - (sum(rows) / len(rows) + 0.5) / m.grid.ny * (n - s_)
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
                      "properties": {"name": src["name"], "gauges": sorted(src.get("gauges", {})),
                                     "hydrograph": src["hydrograph"], "units": "m3/s"}})
    return {"type": "FeatureCollection", "features": feats,
            "properties": {"t0_utc": raw.get("t0_utc"), "note": raw.get("note", "")}}


@app.get("/api/runs/{run_id}/derived/{name}")
def derived_map(run_id: str, name: str, request: Request):
    """arrival|duration|hazard .png|.json, events.json, velocity.json (the manifest) and building_loads.json,
    computed once from the stored depth frames, then served from the runs bucket."""
    from fastapi.responses import RedirectResponse

    from dryrun import derived

    kind, _, ext = name.partition(".")
    if kind not in derived.KINDS or ext not in (("png", "json") if kind in derived.PNG_KINDS else ("json",)):
        raise HTTPException(404, "unknown derived product")
    _check_run(run_id)
    if not derived.exists(run_id, kind):
        m = storage.load_run(run_id)
        if m.status.value != "done" or not m.frames:
            raise HTTPException(409, f"run is {m.status.value}")
        limit(request, "derive", per_hour=120)
        derived.derive_kind(run_id, kind)
    return RedirectResponse(storage.public_run_url(run_id, derived.rel(kind, ext)), status_code=302)


@app.get("/api/runs/{run_id}/derived/velocity/{frame}")
def derived_velocity_frame(run_id: str, frame: int, request: Request):
    """One velocity frame (PNG, encoding in velocity.json). Derives the whole run on first use."""
    from fastapi.responses import RedirectResponse

    from dryrun import derived

    _check_run(run_id)
    m = storage.load_run(run_id)
    if m.status.value != "done" or not m.frames:
        raise HTTPException(409, f"run is {m.status.value}")
    if not 0 <= frame < len(m.frames):
        raise HTTPException(404, "no such frame")
    if not derived.exists(run_id, "velocity"):
        limit(request, "derive", per_hour=120)
        derived.derive_velocity(run_id)
    return RedirectResponse(storage.public_run_url(run_id, derived.velocity_rel(frame)), status_code=302)


@app.get("/api/runs/{run_id}/series")
def depth_series(run_id: str, lon: float, lat: float, request: Request):
    """Depth at one cell for every frame (hover, click-to-pin): the run's frame stack is cached per instance."""
    from dryrun import derived

    if not (math.isfinite(lon) and math.isfinite(lat)):
        raise HTTPException(400, "lon/lat must be finite")
    _check_run(run_id)
    m = storage.load_run(run_id)
    if m.status.value != "done" or not m.frames:
        raise HTTPException(409, f"run is {m.status.value}")
    limit(request, "series", per_hour=3600)
    try:
        body = derived.series(run_id, lon, lat)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    return JSONResponse(body, headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/aoi/{aoi_id}/point")
def aoi_point(aoi_id: str, lon: float, lat: float, request: Request):
    """What is at a map point before any run: place, model ground height, water flags, nearest building."""
    from dryrun.api import point

    if not (math.isfinite(lon) and math.isfinite(lat)):
        raise HTTPException(400, "lon/lat must be finite")
    _check_aoi(aoi_id)
    limit(request, "point", per_hour=3600)
    try:
        body = point.describe(aoi_id, lon, lat)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    return JSONResponse(body, headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/admin/auth")
def admin_auth(request: Request):
    """Current key-auth lockouts (team token only): global window and locked IPs, hashed. Never shows any key."""
    from dryrun.api import authguard

    if not ratelimit._is_team(request):
        raise HTTPException(403, "team only")
    return JSONResponse(authguard.status(), headers={"Cache-Control": "no-store"})


@app.get("/api/aoi/{aoi_id}/presets")
def aoi_presets(aoi_id: str):
    """This AOI's demo ScenarioSpecs, verbatim (a verbatim copy has the warmed run_id, so it opens instantly). [] when
    the AOI has none. Read-only and static."""
    from dryrun import presets

    _check_aoi(aoi_id)
    return JSONResponse(presets.scenarios(aoi_id), headers={"Cache-Control": "public, max-age=300"})


@app.get("/api/aoi/{aoi_id}/level_sensitivity")
def aoi_level_sensitivity(aoi_id: str):
    """Precomputed lagoon/sea level sensitivity: {storm, datum, note, rows: [{level_m, run_id, flooded_km2, buildings}]}.
    404 where the AOI has none."""
    from dryrun import presets

    t = presets.level_sensitivity(aoi_id)
    if t is None:
        raise HTTPException(404, "no level sensitivity table for this AOI")
    return t


@app.get("/api/aoi/{aoi_id}/boundary.geojson")
def boundary_layer(aoi_id: str):
    """Lagoon/sea outline from boundary_mask (empty for inland AOIs)."""
    from dryrun import derived

    _check_aoi(aoi_id)
    return Response(derived.boundary_geojson(aoi_id), media_type="application/geo+json",
                    headers={"Cache-Control": "public, max-age=3600"})


@app.post("/api/aoi/{aoi_id}/rain_field")
def rain_field_preview(aoi_id: str, body: dict, request: Request):
    """Where a Storm's rain falls, before running it: body {"storm": Storm, "sim_hours"?: float}. Returns the
    storm-total depth as a PNG (data URL, AOI grid, north-up) plus the numbers the UI shows next to it."""
    from dryrun import rain_preview

    _check_aoi(aoi_id)
    limit(request, "rain_field", per_hour=1200)
    spec = ScenarioSpec.model_validate({"aoi_id": aoi_id, "storm": body.get("storm"),
                                        **({"sim_hours": body["sim_hours"]} if "sim_hours" in body else {})})
    return JSONResponse(rain_preview.preview(spec))


@app.get("/api/runs/{run_id}/patch3d")
def patch3d_list(run_id: str):
    """3D patches computed for this run (precomputed showcase patches, or ones a batch job finished)."""
    from dryrun.patch3d import run as P

    _check_run(run_id)
    return JSONResponse({"run_id": run_id, "patches": P.index(run_id)})


@app.post("/api/runs/{run_id}/patch3d")
def patch3d_request(run_id: str, body: dict, request: Request):
    """Ask for a 3D patch. 3D solves take minutes to hours, so this never solves in the request: it returns the
    manifest if the patch exists, else records it as queued and starts the batch runner if one is configured
    (DRYRUN_PATCH3D_JOB, a Cloud Run Job)."""
    from dryrun.contracts import Patch3DManifest, Patch3DRequest, RunStatus
    from dryrun.patch3d import run as P

    _check_run(run_id)
    req = Patch3DRequest.model_validate({**body, "run_id": run_id})
    m = storage.load_run(run_id)
    if m.status.value != "done":
        raise HTTPException(409, f"run is {m.status.value}")
    pid = req.patch_id()
    try:
        return JSONResponse(json.loads(P.load_manifest(run_id, pid).model_dump_json()))
    except Exception:  # noqa: BLE001 - not computed yet
        pass
    # a queued patch writes to the public runs bucket and may start a paid Cloud Run Job: team or judge key only
    ratelimit.require_paid_access(request)
    limit(request, "patch3d", per_hour=6)
    ratelimit.limit_global("patch3d", per_day=int(os.getenv("DRYRUN_PATCH3D_PER_DAY", "20")), request=request)
    from dryrun.patch3d import geometry

    try:
        geometry.build(m.scenario.aoi_id, req.center, req.size_m, req.size_m / 8, 0.0)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    job = os.getenv("DRYRUN_PATCH3D_JOB")
    man = Patch3DManifest(patch_id=pid, request=req, status=RunStatus.queued,
                          error=None if job else "no 3D batch runner on this deployment; showcase patches are "
                                                 "precomputed (GET /api/runs/{run_id}/patch3d)")
    P.write_manifest(man)
    P.update_index(man)
    if job:
        from dryrun.patch3d import launch

        launch.start(job, req)
    return JSONResponse(json.loads(man.model_dump_json()), status_code=202)


@app.get("/api/runs/{run_id}/patch3d_inputs")
def patch3d_inputs(run_id: str, lon: float, lat: float, request: Request, size_m: float = 200, cell_m: float = 2.0,
                   t0: float | None = None, t1: float | None = None, dims_only: bool = False):
    """Everything the in-browser (WebGPU) 3D patch solver needs for one box: geometry, the 2D side levels over
    the window, the initial state and the 2D volume series (dryrun/patch3d/inputs.py). Built once per patch
    (a few seconds), then served from the runs bucket. dims_only=1: just the grid (nx, ny, nz, cells), for the
    browser's GPU-memory check before the download."""
    from pydantic import ValidationError

    from dryrun.patch3d import inputs as I

    _check_run(run_id)
    if not all(math.isfinite(x) for x in (lon, lat, size_m, cell_m)):
        raise HTTPException(400, "lon, lat, size_m and cell_m must be finite")
    try:
        req = I.request(run_id, (lon, lat), size_m, cell_m,
                        (t0, t1) if t0 is not None and t1 is not None else None)
    except ValidationError as exc:
        raise HTTPException(400, exc.errors()[0]["msg"]) from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    m = storage.load_run(run_id)
    if m.status.value != "done":
        raise HTTPException(409, f"run is {m.status.value}")
    headers = {"Cache-Control": "public, max-age=86400"}
    if dims_only:
        limit(request, "patch3d_dims", per_hour=120)
        try:
            return JSONResponse(I.dims(req), headers=headers)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from None
    try:
        return Response(storage.read_run_file(run_id, I.rel(req)), media_type="application/json", headers=headers)
    except Exception:  # noqa: BLE001 - not built yet
        pass
    limit(request, "patch3d_inputs", per_hour=30)
    try:
        body = json.dumps(I.build(req)).encode()
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    storage.write_run_file(run_id, I.rel(req), body, "application/json")
    return Response(body, media_type="application/json", headers=headers)


@app.get("/api/runs/{run_id}/patch3d/{patch_id}/{name:path}")
def patch3d_file(run_id: str, patch_id: str, name: str):
    """manifest.json, buildings.json or frames/NNNN_{surface,velocity}.png of a patch (302 to the bucket)."""
    from fastapi.responses import RedirectResponse

    _check_run(run_id)
    if not re.match(r"^p_[0-9a-f]{16}$", patch_id) or not re.match(
            r"^(manifest\.json|buildings\.json|frames/\d{4}_(surface|velocity)\.png)$", name):
        raise HTTPException(404, "unknown patch file")
    if not storage._exists("runs", f"{run_id}/patch3d/{patch_id}/{name}"):
        raise HTTPException(404, "not computed")
    return RedirectResponse(storage.public_run_url(run_id, f"patch3d/{patch_id}/{name}"), status_code=302)


@app.get("/api/compare", response_model=CompareResult)
def compare(base_run_id: str, alt_run_id: str):
    from dryrun.agent.tools import dispatch

    _check_run(base_run_id)
    _check_run(alt_run_id)
    return dispatch("compare_runs", json.dumps({"base_run_id": base_run_id, "alt_run_id": alt_run_id}))


# Eng C endpoints live in their own router to avoid merge conflicts.
from dryrun.api.agent_routes import router as agent_router  # noqa: E402
from dryrun.api.render_routes import router as render_router  # noqa: E402
from dryrun.api.simulate_routes import router as simulate_router  # noqa: E402

app.include_router(agent_router)
app.include_router(simulate_router)
app.include_router(render_router)


# ---- static: run outputs (local mode only) and the built frontend ----
if storage.MODE == "local":
    storage.LOCAL_RUNS.mkdir(parents=True, exist_ok=True)
    app.mount("/runs", StaticFiles(directory=storage.LOCAL_RUNS), name="runs")
_dist = Path(os.getenv("DRYRUN_WEB_DIST", "web/dist"))
if _dist.exists():
    app.mount("/", PrecompressedStatic(directory=_dist, html=True), name="web")
