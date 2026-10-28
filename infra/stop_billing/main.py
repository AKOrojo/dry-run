"""Unlinks billing from the project once the dryrun-cap budget is spent.

Budget notifications arrive on Pub/Sub several times a day. Below the budget this does
nothing; at or above it, it detaches the billing account, which stops every paid service
in the project. Nothing relinks automatically: a human has to do that in the console.
"""

import base64
import json
import logging
import os

import functions_framework
import google.auth
from google.auth.transport.requests import AuthorizedSession

logging.basicConfig(level=logging.INFO)
PROJECT = os.environ["TARGET_PROJECT"]
API = f"https://cloudbilling.googleapis.com/v1/projects/{PROJECT}/billingInfo"


@functions_framework.cloud_event
def stop_billing(event) -> None:
    data = json.loads(base64.b64decode(event.data["message"]["data"]))
    cost, budget = float(data["costAmount"]), float(data["budgetAmount"])
    logging.info("budget notification: cost %.2f of %.2f", cost, budget)
    if cost < budget:
        return

    creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-billing"])
    session = AuthorizedSession(creds)
    info = session.get(API, timeout=30)
    info.raise_for_status()
    if not info.json().get("billingEnabled"):
        return
    resp = session.put(API, json={"billingAccountName": ""}, timeout=30)
    resp.raise_for_status()
    logging.warning("billing disabled for %s at cost %.2f", PROJECT, cost)
