"""Simulation package (owner: Eng A)."""

import hashlib
import os
from pathlib import Path

_SRC = ("solver.py", "fake.py", "interventions.py", "exposure.py", "engine.py")
# The ONE place the backend is read (engine imports it), so run_id and the solver always agree.
BACKEND = os.getenv("DRYRUN_SIM_BACKEND", "fake")  # fake | solver

_h = hashlib.sha256()
for _f in _SRC:
    _p = Path(__file__).with_name(_f)
    if _p.exists():
        _h.update(_p.read_bytes().replace(b"\r\n", b"\n"))  # CRLF checkouts hash the same

# Mixed into run_id: any edit to the sim source, or a backend switch, invalidates cached runs.
# Nobody bumps it by hand. (Re-run scripts/warm_cache.py after deploying sim changes.)
SOLVER_VERSION = f"{BACKEND}-{_h.hexdigest()[:10]}"
