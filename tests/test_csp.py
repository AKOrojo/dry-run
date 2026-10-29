"""The CSP must allow every host the globe's basemap loads from, or the ground renders black."""

import os

os.environ.setdefault("DRYRUN_STORAGE", "local")

from dryrun.api.main import CSP  # noqa: E402


def directive(name: str) -> list[str]:
    return next(d.split()[1:] for d in CSP.split("; ") if d.startswith(name + " "))


def test_bing_imagery_allowed():
    for d in ("img-src", "connect-src"):
        assert "https://dev.virtualearth.net" in directive(d)
        assert "https://*.virtualearth.net" in directive(d)
        assert "https://tile.googleapis.com" in directive(d)


def test_cesium_ion_allowed():
    assert "https://api.cesium.com" in directive("connect-src")
