"""Client-facing error shapes (owner: Eng D). Every non-2xx JSON response carries
{"detail": <unchanged>, "error": {"code", "message", "retryable"}} so the UI branches on a stable code and
shows a sentence written here, not exception text. Model-provider failures get the same treatment in the
agent's SSE error events. Messages never include exception text, URLs or response bodies: those can carry keys."""

from __future__ import annotations

import httpx

_UNAVAILABLE = "The model provider is down or overloaded. Try again shortly or switch provider."

_HTTP: dict[int, tuple[str, bool]] = {
    400: ("bad_request", False), 403: ("forbidden", False), 404: ("not_found", False),
    409: ("conflict", True), 413: ("too_large", False), 415: ("unsupported_media", False),
    422: ("invalid_input", False), 429: ("rate_limited", True), 502: ("upstream_failed", True),
    503: ("unavailable", True),
}


def http_error_code(status: int) -> tuple[str, bool]:
    if status in _HTTP:
        return _HTTP[status]
    return ("server_error", True) if status >= 500 else ("error", False)


def error_body(status: int, detail) -> dict:
    code, retryable = http_error_code(status)
    message = detail if isinstance(detail, str) else "The request failed."
    return {"detail": detail, "error": {"code": code, "message": message, "retryable": retryable}}


def _retry_after(resp: httpx.Response) -> int:
    try:
        return max(1, int(resp.headers.get("retry-after", "")))
    except ValueError:
        return 60


def classify_llm_error(exc: BaseException, stage: str | None = None) -> dict:
    # "not configured" only when building the provider failed; a KeyError mid-chat is a bad response, not setup.
    if isinstance(exc, httpx.HTTPStatusError):
        s = exc.response.status_code
        if s in (401, 403):
            return {"code": "llm_auth", "retryable": False,
                    "message": "The model provider rejected our API key. Try another provider or the fake agent."}
        if s == 429:
            return {"code": "llm_rate_limited", "retryable": True, "retry_after_s": _retry_after(exc.response),
                    "message": "The model provider is rate-limiting us. Wait a minute and try again."}
        if s >= 500:
            return {"code": "llm_unavailable", "retryable": True, "message": _UNAVAILABLE}
        return {"code": "llm_bad_request", "retryable": False, "message": "The model provider refused the request."}
    if isinstance(exc, httpx.TimeoutException):
        return {"code": "llm_timeout", "retryable": True,
                "message": "The model took too long to answer. Try again or ask a simpler question."}
    if isinstance(exc, httpx.TransportError):
        return {"code": "llm_unavailable", "retryable": True, "message": _UNAVAILABLE}
    if stage == "provider" and isinstance(exc, (RuntimeError, KeyError, ValueError)):
        return {"code": "llm_not_configured", "retryable": False,
                "message": "This model provider is not set up on this server. Pick another provider."}
    return {"code": "llm_error", "retryable": True, "message": "The model call failed unexpectedly. Try again."}
