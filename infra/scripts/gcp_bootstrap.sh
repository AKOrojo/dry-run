#!/usr/bin/env bash
# One-time GCP setup (owner: Eng D). Idempotent: safe to re-run.
# Prereqs: gcloud installed, `gcloud auth login`, infra/env.sh filled in.
set -euo pipefail
cd "$(dirname "$0")/../.."
source infra/env.sh

echo "== project"
gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1 || gcloud projects create "$PROJECT_ID" --name="Dry Run"
gcloud config set project "$PROJECT_ID"
[[ -n "$BILLING_ACCOUNT" ]] && gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT"
# `billing projects link` SUCCEEDS against a closed billing account and leaves billingEnabled
# false. Every paid API then fails with UREQ_PROJECT_BILLING_NOT_OPEN several steps later, which
# reads like a permissions problem. Check the thing that actually matters, here, once.
if [[ "$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)')" != "True" ]]; then
  echo "Billing is NOT enabled on $PROJECT_ID (account ${BILLING_ACCOUNT:-unset} is closed or unlinked)." >&2
  echo "Nothing below this line can be created. Reopen the account or create a new one." >&2
  exit 1
fi

echo "== APIs"
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com \
  storage.googleapis.com secretmanager.googleapis.com earthengine.googleapis.com \
  billingbudgets.googleapis.com iam.googleapis.com

echo "== team access (Editor is fine for a 9-day hackathon project; remove after)"
# Empty is the safe default and must stay a no-op. The example ships a@/b@/c@gmail.com as
# placeholders, those are real Google accounts owned by strangers, and an Editor binding to
# one of them is not undone by fixing env.sh later -- so refuse the placeholders outright.
if [[ -z "${TEAM_EMAILS:-}" ]]; then
  echo "   TEAM_EMAILS empty: no team bindings (set real addresses in infra/env.sh and re-run)"
else
  IFS=',' read -ra MEMBERS <<< "$TEAM_EMAILS"
  for m in "${MEMBERS[@]}"; do
    [[ -z "${m// }" ]] && continue
    if [[ "$m" =~ ^user:[abcd]@gmail\.com$ ]]; then
      echo "Refusing to grant Editor to the example placeholder $m -- edit infra/env.sh." >&2
      exit 1
    fi
    gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="$m" --role=roles/editor >/dev/null
  done
fi

echo "== Artifact Registry"
gcloud artifacts repositories describe "$REPO" --location="$REGION" >/dev/null 2>&1 || \
  gcloud artifacts repositories create "$REPO" --repository-format=docker --location="$REGION"

echo "== buckets"
gcloud storage buckets describe "gs://$DATA_BUCKET" >/dev/null 2>&1 || \
  gcloud storage buckets create "gs://$DATA_BUCKET" --location="$REGION" --uniform-bucket-level-access
gcloud storage buckets describe "gs://$RUNS_BUCKET" >/dev/null 2>&1 || \
  gcloud storage buckets create "gs://$RUNS_BUCKET" --location="$REGION" --uniform-bucket-level-access
# Runs bucket is PUBLIC-READ: frames are rendered model output only. Never put user uploads here.
# legacyObjectReader, NOT objectViewer: objectViewer also carries storage.objects.list, which lets
# anyone enumerate every run the service has ever produced. The UI only ever fetches explicit paths
# out of a manifest, so listing is capability we do not use. legacyObjectReader is exactly
# storage.objects.get -- one permission, which is the whole requirement.
gcloud storage buckets add-iam-policy-binding "gs://$RUNS_BUCKET" --member=allUsers --role=roles/storage.legacyObjectReader
# Drop the wider grant if an earlier run of this script applied it.
gcloud storage buckets remove-iam-policy-binding "gs://$RUNS_BUCKET" --member=allUsers --role=roles/storage.objectViewer >/dev/null 2>&1 || true
gcloud storage buckets update "gs://$RUNS_BUCKET" --cors-file=infra/cors.json
# Delete scratch runs after 30 days (demo runs are re-created by scripts/warm_cache.py).
gcloud storage buckets update "gs://$RUNS_BUCKET" --lifecycle-file=infra/lifecycle.json

echo "== runtime service account (least privilege)"
gcloud iam service-accounts describe "$RUNTIME_SA" >/dev/null 2>&1 || \
  gcloud iam service-accounts create dryrun-run --display-name="Dry Run Cloud Run"
# objectUser = read/create/overwrite/delete objects (routes and uploads get re-written), no IAM rights.
gcloud storage buckets add-iam-policy-binding "gs://$DATA_BUCKET" --member="serviceAccount:$RUNTIME_SA" --role=roles/storage.objectUser
gcloud storage buckets add-iam-policy-binding "gs://$RUNS_BUCKET" --member="serviceAccount:$RUNTIME_SA" --role=roles/storage.objectAdmin

echo "== secrets (create empty; each owner adds a version with: printf KEY | gcloud secrets versions add NAME --data-file=-)"
for s in meta-api-key baseten-api-key cesium-ion-token admin-token; do
  gcloud secrets describe "$s" >/dev/null 2>&1 || gcloud secrets create "$s" --replication-policy=automatic
  # Cloud Run refuses to deploy if a referenced secret has no version: seed a placeholder.
  [[ -z "$(gcloud secrets versions list "$s" --limit=1 --format='value(name)')" ]] && \
    printf 'unset' | gcloud secrets versions add "$s" --data-file=- >/dev/null
  gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:$RUNTIME_SA" --role=roles/secretmanager.secretAccessor >/dev/null
done
# Cloud Build's default SA differs by project age (legacy <num>@cloudbuild vs <num>-compute@developer).
# It needs to push to Artifact Registry and write logs:
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
for sa in "${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" "${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"; do
  for role in roles/artifactregistry.writer roles/logging.logWriter roles/storage.objectViewer; do
    gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$sa" --role="$role" >/dev/null 2>&1 || true
  done
done

# Team bypass token for rate limits / admin reload: generate once (shared privately with the team).
if [[ "$(gcloud secrets versions access latest --secret=admin-token)" == "unset" ]]; then
  openssl rand -hex 16 | tr -d '\n' | gcloud secrets versions add admin-token --data-file=- >/dev/null
  echo "   admin-token created: gcloud secrets versions access latest --secret=admin-token"
fi

echo "== image retention (old images are billed storage forever otherwise)"
# No --dry-run: that flag only PREVIEWS deletions. Omitting it is what actually enforces.
gcloud artifacts repositories set-cleanup-policies "$REPO" --location="$REGION" \
  --policy=infra/cleanup-policy.json >/dev/null 2>&1 || \
  echo "!! cleanup policy not applied (needs a recent gcloud): apply infra/cleanup-policy.json by hand"

echo "== budget + hard stop"
if [[ -n "$BILLING_ACCOUNT" ]]; then
  bash infra/scripts/billing_guard.sh \
    || echo "!! billing guard failed (student billing accounts often lack Billing Admin).
   THIS IS THE ONLY THING STOPPING RUNAWAY SPEND. Fix it or set a budget in the console
   before deploying anything: infra/scripts/billing_guard.sh"
else
  echo "!! BILLING_ACCOUNT empty: no budget, no kill switch. Set it in infra/env.sh and re-run."
fi

echo "== done. Optional: register $PROJECT_ID for noncommercial Earth Engine (approval can take >1 day;"
echo "   the data pipeline's PRIMARY path does not need it): https://code.earthengine.google.com/register"
