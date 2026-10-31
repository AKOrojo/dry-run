"""The built frontend, served precompressed and with cache headers.

`npm run build` writes .br and .gz next to each compressible file (web/scripts/precompress.mjs). This picks the best
one the browser accepts, so Cesium.js goes out as ~1 MB instead of 6 MB with no per-request CPU. Without an explicit
Cache-Control, Cloud Run's front end marks every response `private`, so nothing was cached between visits.
"""
from __future__ import annotations

import os

from starlette.responses import FileResponse, Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

# Vite content-hashes everything under assets/; Cesium sits under a cesium-<version>/ path (web/vite.config.ts).
IMMUTABLE = "public, max-age=31536000, immutable"
# index.html names the hashed bundles, so it must be revalidated on every visit or a deploy goes unseen.
REVALIDATE = "no-cache"
# Unhashed files in public/ (favicons and the like).
SHORT = "public, max-age=3600"

ENCODINGS = (("br", ".br"), ("gzip", ".gz"))


def cache_control(path: str) -> str:
    if path.startswith("assets/") or path.startswith("cesium-"):
        return IMMUTABLE
    if path in ("", ".") or path.endswith(".html"):
        return REVALIDATE
    return SHORT


def _accepted(scope: Scope) -> set[str]:
    for k, v in scope.get("headers", []):
        if k == b"accept-encoding":
            return {p.split(";")[0].strip() for p in v.decode("latin-1").lower().split(",")}
    return set()


class PrecompressedStatic(StaticFiles):
    async def get_response(self, path: str, scope: Scope) -> Response:
        resp = await super().get_response(path, scope)
        resp.headers["Cache-Control"] = cache_control(path)
        if not isinstance(resp, FileResponse) or resp.status_code != 200:
            return resp
        resp.headers["Vary"] = "Accept-Encoding"
        accepted = _accepted(scope)
        for enc, ext in ENCODINGS:
            alt = str(resp.path) + ext
            if enc in accepted and os.path.isfile(alt):
                headers = {"Cache-Control": cache_control(path), "Vary": "Accept-Encoding", "Content-Encoding": enc}
                return FileResponse(alt, media_type=resp.media_type, headers=headers)
        return resp
