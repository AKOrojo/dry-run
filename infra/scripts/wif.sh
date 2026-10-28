#!/usr/bin/env bash
# Workload Identity Federation so GitHub Actions can deploy with NO service-account key
# stored in the repo. The provider is restricted to one repository: without that condition
# any GitHub repo in the world could mint tokens for our deploy account.
# Idempotent: safe to re-run. Prints the `gh variable set` commands to finish the wiring.
set -euo pipefail
cd "$(dirname "$0")/../.."
source infra/env.sh

GITHUB_REPO="${GITHUB_REPO:-AKOrojo/dry-run}"
POOL="github"
PROVIDER="github"
DEPLOY_SA="dryrun-deploy@${PROJECT_ID}.iam.gserviceaccount.com"
gc() { gcloud --project "$PROJECT_ID" "$@"; }

echo "== APIs"
gc services enable iamcredentials.googleapis.com sts.googleapis.com iam.googleapis.com

echo "== pool"
gc iam workload-identity-pools describe "$POOL" --location=global >/dev/null 2>&1 || \
  gc iam workload-identity-pools create "$POOL" --location=global --display-name="GitHub Actions"

echo "== provider (restricted to $GITHUB_REPO)"
gc iam workload-identity-pools providers describe "$PROVIDER" --location=global --workload-identity-pool="$POOL" >/dev/null 2>&1 || \
  gc iam workload-identity-pools providers create-oidc "$PROVIDER" --location=global \
    --workload-identity-pool="$POOL" --display-name="GitHub" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository == '${GITHUB_REPO}'"

echo "== deploy service account (least privilege for deploy.sh)"
gc iam service-accounts describe "$DEPLOY_SA" >/dev/null 2>&1 || \
  gc iam service-accounts create dryrun-deploy --display-name="Dry Run CI deploy"
for role in roles/run.admin roles/cloudbuild.builds.editor roles/artifactregistry.writer roles/storage.admin; do
  gc projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$DEPLOY_SA" \
    --role="$role" --condition=None >/dev/null
done
# Scoped to the runtime SA only: deploy may run Cloud Run AS that account, nothing else.
gc iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/iam.serviceAccountUser >/dev/null

echo "== let only $GITHUB_REPO@main impersonate the deploy account"
PROJECT_NUMBER=$(gc projects describe "$PROJECT_ID" --format='value(projectNumber)')
POOL_ID="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}"
gc iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/${POOL_ID}/attribute.ref/refs/heads/main" >/dev/null

WIF_PROVIDER="${POOL_ID}/providers/${PROVIDER}"
cat <<EOF

Done. Set these as repository VARIABLES (not secrets -- none of them are sensitive):

  gh variable set GCP_PROJECT_ID  --repo $GITHUB_REPO --body "$PROJECT_ID"
  gh variable set GCP_REGION      --repo $GITHUB_REPO --body "$REGION"
  gh variable set GCP_WIF_PROVIDER --repo $GITHUB_REPO --body "$WIF_PROVIDER"
  gh variable set GCP_DEPLOY_SA   --repo $GITHUB_REPO --body "$DEPLOY_SA"

Then add a 'production' environment in the repo settings with a required reviewer, so a
deploy cannot run unattended. Pull requests never reach the deploy job.
EOF
