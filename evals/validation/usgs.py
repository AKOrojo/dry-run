"""USGS NWIS gauge hydrographs for riverine presets and timing checks (owner: Eng A).

Public instantaneous-values service, no key. Discharge (00060) is converted from cfs to m3/s; times
are UTC. Used for the Texas Guadalupe preset (4 Jul 2025): the upstream gauges give the inflow,
the downstream gauge (Kerrville) checks the peak magnitude and travel time.

  python evals/validation/usgs.py --sites 08165300 08165500 08166000 08166200 \\
      --start 2025-07-03T23:00 --end 2025-07-05T11:00 --out evals/validation/usgs_guadalupe_20250704.json
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import urllib.parse
import urllib.request

NWIS = "https://waterservices.usgs.gov/nwis/iv/"
CFS_TO_M3S = 0.0283168


def fetch(sites: list[str], start: str, end: str) -> dict:
    """{site: {name, lon, lat, rows: [[UTC "YYYY-MM-DDTHH:MM", m3/s], ...], peak: [time, m3/s]}}."""
    q = urllib.parse.urlencode({"format": "json", "sites": ",".join(sites), "parameterCd": "00060",
                                "startDT": f"{start}Z", "endDT": f"{end}Z", "siteStatus": "all"})
    data = json.load(urllib.request.urlopen(f"{NWIS}?{q}", timeout=120))
    out = {}
    for ts in data["value"]["timeSeries"]:
        info = ts["sourceInfo"]
        site = info["siteCode"][0]["value"]
        geo = info["geogLocation"] if "geogLocation" in info else info["geoLocation"]["geogLocation"]
        rows = []
        for v in ts["values"][0]["value"]:
            q_cfs = float(v["value"])
            if q_cfs < 0:  # -999999 = missing
                continue
            t = dt.datetime.fromisoformat(v["dateTime"]).astimezone(dt.timezone.utc)
            rows.append([t.strftime("%Y-%m-%dT%H:%M"), round(q_cfs * CFS_TO_M3S, 2)])
        peak = max(rows, key=lambda r: r[1]) if rows else None
        out[site] = {"name": info["siteName"], "lon": geo["longitude"], "lat": geo["latitude"],
                     "rows": rows, "peak": peak}
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sites", nargs="+", required=True)
    ap.add_argument("--start", required=True, help="UTC, e.g. 2025-07-03T23:00")
    ap.add_argument("--end", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    res = fetch(a.sites, a.start, a.end)
    with open(a.out, "w") as f:
        json.dump({"units": "m3/s, UTC", "source": "USGS NWIS IV 00060", "sites": res}, f, indent=0)
    for s, v in res.items():
        print(s, v["name"], len(v["rows"]), "rows, peak", v["peak"])


if __name__ == "__main__":
    main()
