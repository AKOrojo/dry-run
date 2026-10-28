#!/usr/bin/env bash
# Budget alerts plus a HARD STOP. A GCP budget is only a notification: it never caps spend.
# This wires budget notifications to Pub/Sub and a function that unlinks the billing account
# at 100%, which stops every paid service in the project until a human relinks it.
# Credits are excluded from the budget, so it tracks real usage while free credits still
# make the net bill zero -- otherwise the first alert arrives after the credits are gone.
# Idempotent: safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/../.."
source infra/env.sh
: "${BILLING_ACCOUNT:?set BILLING_ACCOUNT in infra/env.sh (gcloud billing accounts list)}"

# `gcloud billing budgets` goes through Application Default Credentials, NOT the account from
# `gcloud auth login`, and it needs a quota project. Without ADC it fails with a SERVICE_DISABLED
# error naming Google's own project number, which looks like a permissions problem and is not.
if ! gcloud auth application-default print-access-token >/dev/null 2>&1; then
  echo "No Application Default Credentials. The budget and the kill switch cannot be created." >&2
  echo "Run:  gcloud auth application-default login" >&2
  exit 1
fi
# The billing account must be OPEN. A closed one silently links but leaves billingEnabled=false,
# and every paid API then refuses with UREQ_PROJECT_BILLING_NOT_OPEN.
if [[ "$(gcloud billing accounts describe "$BILLING_ACCOUNT" --format='value(open)' 2>/dev/null)" != "True" ]]; then
  echo "Billing account $BILLING_ACCOUNT is not open. Reopen it or create a new one;" >&2
  echo "nothing in this project can be deployed until it is." >&2
  exit 1
fi

GUARD_SA="dryrun-billing-guard@${PROJECT_ID}.iam.gserviceaccount.com"
BUILD_SA="dryrun-build@${PROJECT_ID}.iam.gserviceaccount.com"
TOPIC="billing-budget"
gc() { gcloud --project "$PROJECT_ID" "$@"; }

echo "== APIs"
gc services enable pubsub.googleapis.com cloudfunctions.googleapis.com cloudbilling.googleapis.com \
  billingbudgets.googleapis.com run.googleapis.com eventarc.googleapis.com cloudbuild.googleapis.com

echo "== topic"
gc pubsub topics describe "$TOPIC" >/dev/null 2>&1 || gc pubsub topics create "$TOPIC"

echo "== guard service account"
gc iam service-accounts describe "$GUARD_SA" >/dev/null 2>&1 || \
  gc iam service-accounts create dryrun-billing-guard --display-name="Dry Run billing guard"
# Project-scoped: it may detach billing from THIS project and nothing else.
gc projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$GUARD_SA" \
  --role=roles/billing.projectManager --condition=None >/dev/null

echo "== build service account"
# Gen2 functions build with their own account; on a fresh project the default compute
# account has no roles, and the deploy fails with a confusing permissions error.
gc iam service-accounts describe "$BUILD_SA" >/dev/null 2>&1 || \
  gc iam service-accounts create dryrun-build --display-name="Dry Run function builds"
gc projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$BUILD_SA" \
  --role=roles/cloudbuild.builds.builder --condition=None >/dev/null

echo "== stop-billing function"
gc functions deploy dryrun-stop-billing --gen2 --region="$REGION" --runtime=python312 \
  --source=infra/stop_billing --entry-point=stop_billing \
  --build-service-account="projects/${PROJECT_ID}/serviceAccounts/${BUILD_SA}" \
  --trigger-topic="$TOPIC" --service-account="$GUARD_SA" --trigger-service-account="$GUARD_SA" \
  --no-allow-unauthenticated --memory=256Mi --max-instances=1 --ingress-settings=internal-only \
  --set-env-vars="TARGET_PROJECT=${PROJECT_ID}"
gc functions add-invoker-policy-binding dryrun-stop-billing --region="$REGION" \
  --member="serviceAccount:$GUARD_SA" >/dev/null

echo "== budget dryrun-cap (\$${BUDGET_USD})"
EXISTING=$(gcloud billing budgets list --billing-account="$BILLING_ACCOUNT" --billing-project="$PROJECT_ID" \
  --filter="displayName=dryrun-cap" --format='value(name)' 2>/dev/null | head -1)
ARGS=(--display-name=dryrun-cap --budget-amount="${BUDGET_USD}USD"
  --filter-projects="projects/${PROJECT_ID}"
  --credit-types-treatment=exclude-all-credits
  --notifications-rule-pubsub-topic="projects/${PROJECT_ID}/topics/${TOPIC}")
if [[ -z "$EXISTING" ]]; then
  gcloud billing budgets create --billing-account="$BILLING_ACCOUNT" --billing-project="$PROJECT_ID" "${ARGS[@]}" \
    --threshold-rule=percent=0.25 --threshold-rule=percent=0.5 --threshold-rule=percent=0.75 \
    --threshold-rule=percent=0.9 --threshold-rule=percent=1.0 \
    --threshold-rule=percent=0.9,basis=forecasted-spend
else
  gcloud billing budgets update "$EXISTING" --billing-account="$BILLING_ACCOUNT" --billing-project="$PROJECT_ID" "${ARGS[@]}"
fi

echo
echo "Budget dryrun-cap: \$${BUDGET_USD}, credits excluded."
echo "At 100% the stop-billing function UNLINKS BILLING from $PROJECT_ID."
echo "Everything paid in the project stops and stays stopped until you relink it by hand."
