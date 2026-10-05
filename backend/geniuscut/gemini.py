"""One place that talks to Gemini, over the REST API with the standard library.

- Model `gemini-3.7-flash` (override with GENIUSCUT_GEMINI_MODEL, read on every call).
- Key from `secrets.gemini_api_key()`, sent as the `x-goog-api-key` header, never in the
  URL, a log line or an error message.
- JSON comes back through `responseMimeType` + `responseJsonSchema`.
- `thinkingConfig.thinkingLevel` on gemini-3* models (older models don't take it) comes
  from GENIUSCUT_GEMINI_THINKING (low|medium|high), default `low`; `effort` is ignored here.
- Before every call the spend gate checks the worst case against the monthly limit, so a
  refused run never reaches the API. Usage is recorded after every reply, even one that
  then fails (a cut-off reply is still billed).
- `client` is an injectable transport `client(url, body, headers) -> dict` for tests.
"""

import json
import os
import urllib.error
import urllib.request

from geniuscut import secrets, spend
from geniuscut.errors import LLMError

DEFAULT_MODEL = "gemini-3.7-flash"
API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models"
TIMEOUT_S = 300
DECLINED = {"SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"}
THINKING_LEVELS = ("low", "medium", "high")
# Default "low", whatever the caller's effort. Measured 2026-10-05 on gemini-3.7-flash with a
# real 10:47 clip (1,560 words): "high" ran out of max_tokens=16000 (12,053 in / 15,986 out,
# $0.069, no usable reply); "low" took 10.2 s, 12,053 in / 2,661 out, $0.019, 45 valid cuts.
DEFAULT_THINKING = "low"


def model() -> str:
    return (os.environ.get("GENIUSCUT_GEMINI_MODEL") or DEFAULT_MODEL).strip()


def thinking_level() -> str:
    """GENIUSCUT_GEMINI_THINKING if it's a valid level, else the default."""
    level = (os.environ.get("GENIUSCUT_GEMINI_THINKING") or "").strip().lower()
    return level if level in THINKING_LEVELS else DEFAULT_THINKING


def _post(url: str, body: dict, headers: dict) -> dict:
    request = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
        return json.loads(response.read().decode("utf-8"))


def _error_message(e: urllib.error.HTTPError) -> str:
    try:
        raw = e.read().decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001 — the status code alone still makes a usable message
        raw = ""
    try:
        msg = (json.loads(raw).get("error") or {}).get("message")
    except (ValueError, AttributeError):
        msg = None
    return msg or raw.strip()[:300] or str(e.reason or e)


def _http_error(e: urllib.error.HTTPError, key: str) -> LLMError:
    msg = _error_message(e).replace(key, "[redacted]")
    if e.code in (400, 403) and "api key" in msg.lower():
        return LLMError(f"The Gemini API key was rejected: {msg}")
    if e.code == 429:
        return LLMError(f"Gemini is rate-limiting requests; try again shortly. {msg}")
    return LLMError(f"Gemini API error {e.code}: {msg}")


def _usage(response: dict) -> tuple[int, int]:
    """(input, output) tokens; thinking is billed as output."""
    u = response.get("usageMetadata") or {}
    return (int(u.get("promptTokenCount") or 0),
            int(u.get("candidatesTokenCount") or 0) + int(u.get("thoughtsTokenCount") or 0))


def _call(prompt: str, *, system: str | None, client, effort: str, max_tokens: int,
          schema: dict | None) -> str:
    name = model()
    spend.check_budget(name, (system or "") + prompt, max_tokens)
    config = {"maxOutputTokens": max_tokens}
    if schema is not None:
        config.update(responseMimeType="application/json", responseJsonSchema=schema)
    if name.startswith("gemini-3"):
        config["thinkingConfig"] = {"thinkingLevel": thinking_level()}
    body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}], "generationConfig": config}
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}

    key = secrets.gemini_api_key()
    headers = {"Content-Type": "application/json", "x-goog-api-key": key}
    try:
        response = (client or _post)(f"{API_ROOT}/{name}:generateContent", body, headers)
    except urllib.error.HTTPError as e:
        raise _http_error(e, key) from None  # `from None`: the request (and its key header) stays out of tracebacks
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise LLMError("Couldn't reach the Gemini API. Check the internet connection.") from e

    spend.record(name, *_usage(response))
    block = (response.get("promptFeedback") or {}).get("blockReason")
    if block:
        raise LLMError(f"Gemini declined the request ({block}).")
    candidate = (response.get("candidates") or [{}])[0]
    finish = candidate.get("finishReason")
    if finish in DECLINED:
        raise LLMError(f"Gemini declined the request ({finish}).")
    if finish == "MAX_TOKENS":
        raise LLMError("Gemini's reply was cut off at max_tokens. Try a shorter clip.")
    parts = (candidate.get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
    if not text.strip():
        raise LLMError("Gemini returned no text.")
    return text


def ask_json(prompt: str, schema: dict, *, system: str | None = None, client=None,
             effort: str = "high", max_tokens: int = 16000) -> dict:
    text = _call(prompt, system=system, client=client, effort=effort, max_tokens=max_tokens, schema=schema)
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise LLMError(f"Gemini returned invalid JSON: {e}") from e


def ask_text(prompt: str, *, system: str | None = None, client=None,
             effort: str = "medium", max_tokens: int = 16000) -> str:
    return _call(prompt, system=system, client=client, effort=effort, max_tokens=max_tokens, schema=None)
