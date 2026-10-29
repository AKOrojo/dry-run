"""AOI-mean half-hourly rainfall from NASA GPM IMERG V07 (owner: Eng A).

Replaces assumed storms with the satellite estimate for a validation window. Uses the Final run
(GPM_3IMERGHH) where it exists, else the Late run (GPM_3IMERGHHL, ~14 h latency; Final lags ~3.5 months).
Files come from the Earthdata Cloud host; the old gpm1.gesdisc host is not reachable from every network.

Needs EARTHDATA_TOKEN (Earthdata Login > Generate Token; at most 2 active per user, so reuse it) and the
"NASA GESDISC DATA ARCHIVE" EULA accepted on the profile. Needs h5py (`pip install -e .[validation]`).

  set -a; . ./.env; set +a
  python evals/validation/imerg.py --bbox 3.470 6.420 3.620 6.510 \\
      --start 2026-07-09T12:00 --end 2026-07-13T00:00 --out evals/validation/imerg_lagos_20260709-12.json
"""

from __future__ import annotations

import argparse
import io
import json
import os
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np

CMR = "https://cmr.earthdata.nasa.gov/search/granules.json"
HOST = "https://data.gesdisc.earthdata.nasa.gov/"
PRODUCTS = ("GPM_3IMERGHH", "GPM_3IMERGHHL")  # Final first, then Late
HALF_CELL = 0.05  # IMERG grid is 0.1 deg; take every cell whose centre is within half a cell of the bbox


def _granules(short_name: str, start: str, end: str) -> list[tuple[str, str]]:
    q = urllib.parse.urlencode({"short_name": short_name, "version": "07", "temporal": f"{start}:00Z,{end}:00Z",
                                "page_size": 2000, "sort_key": "start_date"})
    feed = json.load(urllib.request.urlopen(f"{CMR}?{q}", timeout=60))["feed"]["entry"]
    out = []
    for e in feed:
        href = next((link["href"] for link in e["links"]
                     if link["href"].startswith(HOST) and link["href"].endswith(".HDF5")), None)
        if href:
            out.append((e["time_start"], href))
    return out


def _aoi_mean(href: str, bbox: tuple[float, float, float, float], token: str) -> float:
    import h5py

    req = urllib.request.Request(href, headers={"Authorization": f"Bearer {token}"})
    for attempt in range(3):
        try:
            data = urllib.request.urlopen(req, timeout=300).read()
            break
        except OSError:
            if attempt == 2:
                raise
    g = h5py.File(io.BytesIO(data))["Grid"]
    lon, lat, p = g["lon"][:], g["lat"][:], g["precipitation"][0]  # p is (lon, lat), mm/h
    w, s, e, n = bbox
    i = (lon >= w - HALF_CELL) & (lon <= e + HALF_CELL)
    j = (lat >= s - HALF_CELL) & (lat <= n + HALF_CELL)
    return float(np.mean(p[np.ix_(i, j)]))


def fetch(bbox: tuple[float, float, float, float], start: str, end: str, token: str) -> dict:
    """Half-hour rows of [UTC start "YYYY-MM-DDTHH:MM", AOI-mean mm/h]."""
    for product in PRODUCTS:
        grans = _granules(product, start, end)
        if grans:
            break
    else:
        raise SystemExit(f"no IMERG granules for {start}..{end}")
    with ThreadPoolExecutor(6) as ex:
        rates = list(ex.map(lambda g: _aoi_mean(g[1], bbox, token), grans))
    rows = [[t[:16], round(r, 3)] for (t, _), r in zip(grans, rates)]
    return {"product": f"{product}.07", "bbox": list(bbox), "units": "mm/h, AOI mean, 30 min steps",
            "total_mm": round(sum(r for _, r in rows) * 0.5, 1), "rows": rows}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", type=float, nargs=4, required=True, metavar=("W", "S", "E", "N"))
    ap.add_argument("--start", required=True, help="UTC, e.g. 2026-07-09T12:00")
    ap.add_argument("--end", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    token = os.environ.get("EARTHDATA_TOKEN")
    if not token:
        raise SystemExit("EARTHDATA_TOKEN is not set")
    res = fetch(tuple(a.bbox), a.start, a.end, token)
    with open(a.out, "w") as f:
        json.dump(res, f, indent=0)
    print(res["product"], len(res["rows"]), "steps,", res["total_mm"], "mm")


if __name__ == "__main__":
    main()
