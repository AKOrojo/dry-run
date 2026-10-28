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

echo "== provider (restricted to $GITHUB_REPO @ main)"
# The condition is the gate on token minting, so it carries BOTH restrictions. Repository
# alone would let any branch -- including one a contributor pushed five minutes ago --
# mint a token that can deploy to production. Requiring refs/heads/main means only code
# that went through main's branch protection can reach the deploy account. deploy.yml has
# its own ref check; this one is the control that holds even if the workflow is edited.
MAPPING="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref"
CONDITION="assertion.repository == '${GITHUB_REPO}' && assertion.ref == 'refs/heads/main'"
if gc iam workload-identity-pools providers describe "$PROVIDER" --location=global \
     --workload-identity-pool="$POOL" >/dev/null 2>&1; then
  # Reconcile: a provider created by an earlier run has the weaker repository-only condition
  # and re-running the script must tighten it, not silently leave production wide open.
  gc iam workload-identity-pools providers update-oidc "$PROVIDER" --location=global \
    --workload-identity-pool="$POOL" \
    --attribute-mapping="$MAPPING" --attribute-condition="$CONDITION" >/dev/null
else
  gc iam workload-identity-pools providers create-oidc "$PROVIDER" --location=global \
    --workload-identity-pool="$POOL" --display-name="GitHub" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="$MAPPING" --attribute-condition="$CONDITION"
fi

echo "== deploy service account (least privilege for deploy.sh)"
if ! gc iam service-accounts describe "$DEPLOY_SA" >/dev/null 2>&1; then
  gc iam service-accounts create dryrun-deploy --display-name="Dry Run CI deploy"
  # `create` returns before the account is visible to the IAM policy API, which then rejects
  # the very next binding with "Service account does not exist" -- a lie that reads like a
  # typo. Observed on the first real run of this script. Wait for it to actually resolve.
  for _ in $(seq 30); do
    gc iam service-accounts describe "$DEPLOY_SA" >/dev/null 2>&1 && break
    sleep 2
  done
fi
# A fresh service account is not immediately visible to the IAM *policy* API even after
# `describe` succeeds -- the two propagate separately, so waiting on describe alone is not
# enough. Binding it then fails INVALID_ARGUMENT "does not exist", which is eventual
# consistency wearing a permissions error's clothing. Retry rather than trust one attempt.
bind_retry() {
  for attempt in $(seq 10); do
    "$@" >/dev/null 2>&1 && return 0
    sleep 3
  done
  echo "IAM binding still failing after 30s: $*" >&2
  "$@" >/dev/null   # run once more unsilenced so the real error reaches the operator
}
for role in roles/run.admin roles/cloudbuild.builds.editor roles/artifactregistry.writer roles/storage.admin; do
  bind_retry gc projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$DEPLOY_SA" \
    --role="$role" --condition=None
done
# Scoped to the runtime SA only: deploy may run Cloud Run AS that account, nothing else.
bind_retry gc iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/iam.serviceAccountUser

echo "== let only $GITHUB_REPO impersonate the deploy account"
PROJECT_NUMBER=$(gc projects describe "$PROJECT_ID" --format='value(projectNumber)')
POOL_ID="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}"
# Bind on attribute.repository, NOT attribute.ref. `attribute.ref/refs/heads/main` grants
# impersonation to anything in the pool sitting on a branch called main -- it says nothing
# about WHICH repository, so it is only as strong as the provider's attribute-condition.
# Add a second provider to this pool without that condition and every main branch on GitHub
# inherits deploy rights. attribute.repository is bound to a claim GitHub signs, so the
# restriction holds no matter what else is later attached to the pool. The branch
# restriction is enforced by the provider condition below and by deploy.yml's ref check.
bind_retry gc iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/${POOL_ID}/attribute.repository/${GITHUB_REPO}"
# Remove the older, weaker branch-only binding if a previous run of this script created it.
gc iam service-accounts remove-iam-policy-binding "$DEPLOY_SA" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/${POOL_ID}/attribute.ref/refs/heads/main" >/dev/null 2>&1 || true

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
