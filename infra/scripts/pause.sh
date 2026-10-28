#!/usr/bin/env bash
# Cost and traffic controls for the deployed service.
#
#   bash infra/scripts/pause.sh          -> min-instances 0. Kills IDLE cost only.
#                                           The service STILL SERVES every request.
#   bash infra/scripts/pause.sh resume   -> min-instances 1, for a demo or recording.
#   bash infra/scripts/pause.sh stop     -> revoke public access. THE EMERGENCY BRAKE:
#                                           the URL starts returning 403 and nothing
#                                           downstream (LLM, solver, egress) can be billed.
#   bash infra/scripts/pause.sh start    -> re-open to the public.
#
# Reach for `stop`, not `pause`, when you are being abused. Scaling to zero does not
# stop an attacker: Cloud Run just starts an instance for their next request.
set -euo pipefail
cd "$(dirname "$0")/../.."
source infra/env.sh

MODE="${1:-pause}"
run() { gcloud run services "$@" "$SERVICE" --project "$PROJECT_ID" --region "$REGION"; }

case "$MODE" in
  pause)  run update --min-instances 0 ;;
  resume) run update --min-instances 1 ;;
  stop)
    run remove-iam-policy-binding --member=allUsers --role=roles/run.invoker >/dev/null
    run update --min-instances 0
    echo "PUBLIC ACCESS REVOKED. The URL now returns 403. Re-open with: $0 start"
    ;;
  start)
    run add-iam-policy-binding --member=allUsers --role=roles/run.invoker >/dev/null
    echo "public access restored"
    ;;
  *) echo "usage: $0 [pause|resume|stop|start]" >&2; exit 2 ;;
esac

run describe --format='value(status.url)'
