"""Start a 3D patch on the Cloud Run Job named by DRYRUN_PATCH3D_JOB (owner: Eng A; the job image is Eng D's:
OpenFOAM v2406 plus this package). The job runs `python -m dryrun.patch3d.run` with the request's arguments."""

from __future__ import annotations

import json
import urllib.request

from dryrun.contracts import Patch3DRequest


def start(job: str, req: Patch3DRequest) -> None:
    """job = projects/<p>/locations/<region>/jobs/<name>. Uses the service account's metadata token."""
    tok = json.loads(urllib.request.urlopen(urllib.request.Request(
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
        headers={"Metadata-Flavor": "Google"}), timeout=10).read())["access_token"]
    args = ["-m", "dryrun.patch3d.run", "--run", req.run_id, "--center", str(req.center[0]), str(req.center[1]),
            "--size", str(req.size_m), "--cell", str(req.cell_m)]
    if req.t_window_s:
        args += ["--t0", str(req.t_window_s[0]), "--t1", str(req.t_window_s[1])]
    body = {"overrides": {"containerOverrides": [{"args": args}], "taskCount": 1}}
    urllib.request.urlopen(urllib.request.Request(
        f"https://run.googleapis.com/v2/{job}:run", data=json.dumps(body).encode(), method="POST",
        headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}), timeout=30)
