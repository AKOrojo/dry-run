#!/usr/bin/env bash
# Build + deploy (owner: Eng D; anyone may run it after Day 2).
#   bash infra/scripts/deploy.sh            -> normal deploy, scale-to-zero
#   DEMO=1 bash infra/scripts/deploy.sh     -> demo day: 1 warm instance (costs ~$1-2/day)
set -euo pipefail
cd "$(dirname "$0")/../.."
# Locally infra/env.sh supplies everything. In CI it does not exist: the deploy workflow
# exports PROJECT_ID and REGION from repo variables and the rest falls back to the same
# defaults as infra/env.sh.example.
[[ -f infra/env.sh ]] && source infra/env.sh
: "${PROJECT_ID:?set PROJECT_ID (infra/env.sh locally, GCP_PROJECT_ID repo variable in CI)}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-dryrun}"
REPO="${REPO:-dryrun}"
DATA_BUCKET="${DATA_BUCKET:-${PROJECT_ID}-data}"
RUNS_BUCKET="${RUNS_BUCKET:-${PROJECT_ID}-runs}"
RUNTIME_SA="${RUNTIME_SA:-dryrun-run@${PROJECT_ID}.iam.gserviceaccount.com}"
git rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git repo: run 'git init' and commit first"; exit 1; }
[[ -f web/package-lock.json ]] || { echo "web/package-lock.json missing: run 'cd web && npm install' and commit it"; exit 1; }
TAG=$(git rev-parse --short HEAD)$( [[ -n "$(git status --porcelain)" ]] && echo "-dirty" || true )
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/api:${TAG}"
MIN=$([[ "${DEMO:-0}" == "1" ]] && echo 1 || echo 0)
# ONE --set-env-vars flag: repeating it does not merge values.
ENV_VARS="DRYRUN_STORAGE=gcs,DRYRUN_DATA_BUCKET=${DATA_BUCKET},DRYRUN_RUNS_BUCKET=${RUNS_BUCKET}"
ENV_VARS+=",DRYRUN_PUBLIC_RUNS_BASE=https://storage.googleapis.com/${RUNS_BUCKET}/runs"
ENV_VARS+=",DRYRUN_SIM_BACKEND=${SIM_BACKEND:-fake},DRYRUN_AGENT_PROVIDER=${AGENT_PROVIDER:-fake}"
ENV_VARS+=",DRYRUN_DEFAULT_AOI=${DEFAULT_AOI:-fixture-synthetic},DRYRUN_AGENT_PER_HOUR=${AGENT_PER_HOUR:-12}"
ENV_VARS+=",DRYRUN_AGENT_PER_DAY=${AGENT_PER_DAY:-300},DRYRUN_BUILDINGS_URL=${BUILDINGS_URL:-}"
if [[ "${SIM_BACKEND:-fake}" == "fake" || "${AGENT_PROVIDER:-fake}" == "fake" ]]; then
  echo "!! deploying with SIM_BACKEND=${SIM_BACKEND:-fake} AGENT_PROVIDER=${AGENT_PROVIDER:-fake} (placeholder physics/agent)."
  [[ "${DEMO:-0}" == "1" ]] && { echo "refusing: DEMO=1 must run solver + meta"; exit 1; }
fi

gcloud builds submit --project "$PROJECT_ID" --config infra/cloudbuild.yaml \
  --substitutions=_TAG="$TAG",_REGION="$REGION",_REPO="$REPO" .

gcloud run deploy "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --image "$IMAGE" \
  --service-account "$RUNTIME_SA" --allow-unauthenticated \
  --cpu 2 --memory 4Gi --concurrency 4 --timeout 900 --cpu-boost \
  --min-instances "$MIN" --max-instances 3 \
  --set-env-vars "$ENV_VARS" \
  --set-secrets "META_API_KEY=meta-api-key:latest,BASETEN_API_KEY=baseten-api-key:latest,CESIUM_ION_TOKEN=cesium-ion-token:latest,DRYRUN_ADMIN_TOKEN=admin-token:latest"

URL=$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')
echo "Deployed $TAG -> $URL"
curl -fsS "$URL/api/health" && echo || echo "!! health check failed: gcloud run services logs read $SERVICE --region $REGION"
