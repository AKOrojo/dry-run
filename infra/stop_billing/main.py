"""Unlinks billing from the project once the dryrun-cap budget is spent.

Budget notifications arrive on Pub/Sub several times a day. Below the budget this does
nothing; at or above it, it detaches the billing account, which stops every paid service
in the project. Nothing relinks automatically: a human has to do that in the console.
"""

import base64
import json
import os

import functions_framework
import google.auth
from google.auth.transport.requests import AuthorizedSession

# print(), not logging: the functions-framework worker owns the root logger, and
# logging.basicConfig() here is a no-op -- the first test run produced empty log entries
# and no way to tell "declined to act" from "crashed". Unbuffered stdout is captured
# reliably, and being able to read this log is the only evidence the guard works.
PROJECT = os.environ["TARGET_PROJECT"]
API = f"https://cloudbilling.googleapis.com/v1/projects/{PROJECT}/billingInfo"


def log(msg: str) -> None:
    print(msg, flush=True)


@functions_framework.cloud_event
def stop_billing(event) -> None:
    data = json.loads(base64.b64decode(event.data["message"]["data"]))
    cost, budget = float(data["costAmount"]), float(data["budgetAmount"])
    log(f"budget notification: cost {cost:.2f} of {budget:.2f}")
    if cost < budget:
        log("under budget, no action")
        return

    creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-billing"])
    session = AuthorizedSession(creds)
    # No GET first. roles/billing.projectManager grants exactly two permissions --
    # createBillingAssignment and deleteBillingAssignment -- and NOT
    # billing.projectBillingInfo.get, so reading billingInfo 403s and the function dies
    # before it ever unlinks. A live test at the threshold is how that was found.
    # The PUT is idempotent: unlinking an already-unlinked project is a no-op, so the
    # read it replaced was only ever an optimisation. Least privilege stays intact.
    resp = session.put(API, json={"billingAccountName": ""}, timeout=30)
    resp.raise_for_status()
    log(f"BILLING DISABLED for {PROJECT} at cost {cost:.2f}")
