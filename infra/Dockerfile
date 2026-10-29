# One image = API + built frontend. Build context is the REPO ROOT:
#   docker build -f infra/Dockerfile .
# Cloud Build does this for you (infra/cloudbuild.yaml).

# ---------- stage 1: web ----------
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
# Same-origin in prod: the API is served by this container, so API base is "".
# Cesium token is NOT baked in: the app reads it from /api/config at runtime.
ENV VITE_API_BASE=""
RUN npm run build

# ---------- stage 2: api ----------
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY pyproject.toml ./
COPY dryrun/ ./dryrun/
# sim = numba. Pipeline (GDAL/rasterio/osmnx) and surrogate-training extras stay OUT of the image.
RUN pip install ".[sim,meta]"
# Compile the numba solver kernel at build time (cold first call 2.3 s instead of 3.4 s). The cache dir must
# stay WRITABLE by the runtime user: without it the solver CRASHES ("cannot cache function: no locator
# available") because /app is read-only to uid 10001 and numba refuses a read-only location; a Cloud Run CPU
# that differs from the build machine's recompiles once and rewrites it.
ENV NUMBA_CACHE_DIR=/app/.numba_cache
RUN python -c "from dryrun.sim.solver import warmup; warmup()" && ls "$NUMBA_CACHE_DIR" | grep -q .
COPY --from=web /web/dist ./web/dist
ENV DRYRUN_WEB_DIST=/app/web/dist PORT=8080
# Non-root. Nothing in the image is written at runtime -- state lives in GCS -- so the whole
# tree can stay read-only to the service. A bug in an upload or render path then cannot
# overwrite the code it is running. Writable: runs/, data/ (local caches) and the numba cache.
RUN useradd --system --uid 10001 --no-create-home dryrun \
 && chmod -R a-w /app \
 && mkdir -p /app/runs /app/data && chown 10001:0 /app/runs /app/data && chmod 750 /app/runs /app/data \
 && chown -R 10001:0 /app/.numba_cache && chmod -R u+w /app/.numba_cache
USER 10001
# Cloud Run sets $PORT. 1 worker: the solver is CPU-bound, Cloud Run scales instances instead.
CMD exec uvicorn dryrun.api.main:app --host 0.0.0.0 --port ${PORT} --workers 1 --timeout-keep-alive 75
