"""The frontend is served precompressed with cache headers; the SSE streams are never gzip-buffered."""
import gzip

from fastapi import FastAPI
from fastapi.testclient import TestClient

from dryrun.api.static import PrecompressedStatic, cache_control


def _client(tmp_path):
    (tmp_path / "assets").mkdir()
    (tmp_path / "cesium-1.146.0").mkdir()
    js = b"console.log('x');" * 200
    (tmp_path / "assets" / "index-abc.js").write_bytes(js)
    (tmp_path / "assets" / "index-abc.js.br").write_bytes(b"BR")
    (tmp_path / "assets" / "index-abc.js.gz").write_bytes(gzip.compress(js))
    (tmp_path / "cesium-1.146.0" / "Cesium.js").write_bytes(js)
    (tmp_path / "index.html").write_bytes(b"<html></html>")
    app = FastAPI()
    app.mount("/", PrecompressedStatic(directory=tmp_path, html=True), name="web")
    return TestClient(app), js


def test_brotli_preferred(tmp_path):
    c, _ = _client(tmp_path)
    r = c.get("/assets/index-abc.js", headers={"Accept-Encoding": "gzip, br"})
    assert r.headers["content-encoding"] == "br"
    assert r.headers["content-type"].startswith("text/javascript") or "javascript" in r.headers["content-type"]
    assert r.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert r.headers["vary"] == "Accept-Encoding"


def test_gzip_when_no_brotli(tmp_path):
    c, js = _client(tmp_path)
    r = c.get("/assets/index-abc.js", headers={"Accept-Encoding": "gzip"})
    assert r.headers["content-encoding"] == "gzip"
    assert r.content == js  # the client decodes it


def test_identity_without_accept_encoding(tmp_path):
    c, js = _client(tmp_path)
    r = c.get("/assets/index-abc.js", headers={"Accept-Encoding": "identity"})
    assert "content-encoding" not in r.headers
    assert r.content == js


def test_cache_headers(tmp_path):
    c, _ = _client(tmp_path)
    assert c.get("/").headers["cache-control"] == "no-cache"
    assert c.get("/cesium-1.146.0/Cesium.js").headers["cache-control"].endswith("immutable")
    assert cache_control("favicon.svg") == "public, max-age=3600"
    assert c.get("/missing.js").status_code == 404


def test_api_json_gzipped_and_stream_not():
    from starlette.middleware.gzip import DEFAULT_EXCLUDED_CONTENT_TYPES, GZipMiddleware

    from dryrun.api.main import app
    r = TestClient(app).get("/openapi.json", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200
    assert len(r.content) > 1024 and r.headers.get("content-encoding") == "gzip"
    assert any(m.cls is GZipMiddleware for m in app.user_middleware)
    assert "text/event-stream" in DEFAULT_EXCLUDED_CONTENT_TYPES
