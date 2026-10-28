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
COPY --from=web /web/dist ./web/dist
ENV DRYRUN_WEB_DIST=/app/web/dist PORT=8080
# Non-root. Nothing in the image is written at runtime -- state lives in GCS -- so the whole
# tree can stay read-only to the service. A bug in an upload or render path then cannot
# overwrite the code it is running.
RUN useradd --system --uid 10001 --no-create-home dryrun \
 && chmod -R a-w /app \
 && mkdir -p /app/runs /app/data && chown 10001:0 /app/runs /app/data && chmod 750 /app/runs /app/data
USER 10001
# Cloud Run sets $PORT. 1 worker: the solver is CPU-bound, Cloud Run scales instances instead.
CMD exec uvicorn dryrun.api.main:app --host 0.0.0.0 --port ${PORT} --workers 1 --timeout-keep-alive 75
