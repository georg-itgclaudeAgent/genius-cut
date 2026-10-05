"""Gemini over REST, through an injected transport: no network, no paid calls."""

import io
import json
import socket
import urllib.error

import pytest

from geniuscut import gemini, llm, secrets, spend

KEY = "AIza-test-key-not-real"


@pytest.fixture(autouse=True)
def _key(monkeypatch):
    monkeypatch.setenv("GENIUSCUT_GEMINI_API_KEY", KEY)


def reply(text='{"ok": true}', *, finish="STOP", parts=None, usage=None, **extra):
    body = {"candidates": [{"content": {"role": "model", "parts": parts or [{"text": text}]},
                            "finishReason": finish}],
            "usageMetadata": usage or {"promptTokenCount": 100, "candidatesTokenCount": 20}}
    body.update(extra)
    return body


class Transport:
    """Records each request and answers with a canned body (or raises)."""

    def __init__(self, body=None, raises=None):
        self.calls = []
        self.body = body if body is not None else reply()
        self.raises = raises

    def __call__(self, url, body, headers):
        self.calls.append({"url": url, "body": body, "headers": headers})
        if self.raises:
            raise self.raises
        return self.body


def http_error(code, message):
    payload = json.dumps({"error": {"code": code, "message": message}}).encode()
    return urllib.error.HTTPError("https://generativelanguage.googleapis.com/x", code, "err", {}, io.BytesIO(payload))


# ── request ────────────────────────────────────────────────────────

def test_json_request_body_url_and_key_header():
    t = Transport()
    schema = {"type": "object", "properties": {"ok": {"type": "boolean"}}}
    assert gemini.ask_json("hi", schema, system="be brief", client=t, max_tokens=1234) == {"ok": True}
    call = t.calls[0]
    assert call["url"] == ("https://generativelanguage.googleapis.com/v1beta/models/"
                           "gemini-3.7-flash:generateContent")
    assert call["headers"]["x-goog-api-key"] == KEY
    assert KEY not in call["url"]
    body = call["body"]
    assert body["systemInstruction"] == {"parts": [{"text": "be brief"}]}
    assert body["contents"] == [{"role": "user", "parts": [{"text": "hi"}]}]
    cfg = body["generationConfig"]
    assert cfg["maxOutputTokens"] == 1234
    assert cfg["responseMimeType"] == "application/json"
    assert cfg["responseJsonSchema"] == schema
    assert cfg["thinkingConfig"] == {"thinkingLevel": "high"}


def test_text_request_has_no_schema_and_no_system_when_none():
    t = Transport(reply("- Rule one."))
    assert gemini.ask_text("hi", client=t) == "- Rule one."
    body = t.calls[0]["body"]
    assert "systemInstruction" not in body
    assert "responseMimeType" not in body["generationConfig"]
    assert "responseJsonSchema" not in body["generationConfig"]
    assert body["generationConfig"]["thinkingConfig"] == {"thinkingLevel": "medium"}


@pytest.mark.parametrize("effort", ["low", "medium", "high"])
def test_effort_maps_to_thinking_level_on_gemini_3(effort):
    t = Transport()
    gemini.ask_json("hi", {}, client=t, effort=effort)
    assert t.calls[0]["body"]["generationConfig"]["thinkingConfig"] == {"thinkingLevel": effort}


def test_no_thinking_level_for_older_models(monkeypatch):
    monkeypatch.setenv("GENIUSCUT_GEMINI_MODEL", "gemini-2.5-flash")
    t = Transport()
    gemini.ask_json("hi", {}, client=t)
    assert "gemini-2.5-flash:generateContent" in t.calls[0]["url"]
    assert "thinkingConfig" not in t.calls[0]["body"]["generationConfig"]


# ── reply ──────────────────────────────────────────────────────────

def test_thought_parts_are_skipped_and_text_parts_joined():
    t = Transport(reply(parts=[{"text": "thinking about it...", "thought": True},
                               {"text": '{"cuts": '}, {"text": "[]}"}]))
    assert gemini.ask_json("hi", {}, client=t) == {"cuts": []}


@pytest.mark.parametrize("reason", ["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"])
def test_declined_finish_reasons(reason):
    with pytest.raises(llm.LLMError, match=rf"^Gemini declined the request \({reason}\)\.$"):
        gemini.ask_json("hi", {}, client=Transport(reply(finish=reason)))


def test_prompt_block_reason():
    body = {"promptFeedback": {"blockReason": "OTHER"}, "usageMetadata": {"promptTokenCount": 5}}
    with pytest.raises(llm.LLMError, match=r"^Gemini declined the request \(OTHER\)\.$"):
        gemini.ask_json("hi", {}, client=Transport(body))


def test_max_tokens_is_cut_off():
    with pytest.raises(llm.LLMError, match=r"^Gemini's reply was cut off at max_tokens\. Try a shorter clip\.$"):
        gemini.ask_json("hi", {}, client=Transport(reply('{"cu', finish="MAX_TOKENS")))


def test_empty_text():
    with pytest.raises(llm.LLMError, match=r"^Gemini returned no text\.$"):
        gemini.ask_text("hi", client=Transport(reply(parts=[{"text": "hmm", "thought": True}])))


def test_invalid_json():
    with pytest.raises(llm.LLMError, match=r"^Gemini returned invalid JSON: "):
        gemini.ask_json("hi", {}, client=Transport(reply("not json")))


# ── HTTP errors ────────────────────────────────────────────────────

@pytest.mark.parametrize("code", [400, 403])
def test_rejected_key(code):
    err = http_error(code, f"API key not valid. Please pass a valid API key. ({KEY})")
    with pytest.raises(llm.LLMError) as e:
        gemini.ask_json("hi", {}, client=Transport(raises=err))
    assert str(e.value).startswith("The Gemini API key was rejected: API key not valid.")
    assert KEY not in str(e.value)


def test_rate_limited():
    err = http_error(429, "Resource has been exhausted (e.g. check quota).")
    with pytest.raises(llm.LLMError) as e:
        gemini.ask_json("hi", {}, client=Transport(raises=err))
    assert str(e.value) == ("Gemini is rate-limiting requests; try again shortly. "
                            "Resource has been exhausted (e.g. check quota).")


def test_other_http_error():
    with pytest.raises(llm.LLMError) as e:
        gemini.ask_json("hi", {}, client=Transport(raises=http_error(500, "Internal error encountered.")))
    assert str(e.value) == "Gemini API error 500: Internal error encountered."


def test_400_without_a_key_message_is_a_plain_api_error():
    with pytest.raises(llm.LLMError, match=r"^Gemini API error 400: Invalid JSON schema\.$"):
        gemini.ask_json("hi", {}, client=Transport(raises=http_error(400, "Invalid JSON schema.")))


def test_http_error_with_a_non_json_body():
    err = urllib.error.HTTPError("u", 502, "Bad Gateway", {}, io.BytesIO(b"<html>nope</html>"))
    with pytest.raises(llm.LLMError, match=r"^Gemini API error 502: "):
        gemini.ask_json("hi", {}, client=Transport(raises=err))


@pytest.mark.parametrize("exc", [urllib.error.URLError("getaddrinfo failed"), TimeoutError("timed out"),
                                 socket.timeout("timed out")])
def test_unreachable(exc):
    with pytest.raises(llm.LLMError, match=r"^Couldn't reach the Gemini API\. Check the internet connection\.$"):
        gemini.ask_json("hi", {}, client=Transport(raises=exc))


def test_default_transport_uses_a_300s_timeout(monkeypatch):
    seen = {}

    class Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(request, timeout):
        seen.update(timeout=timeout, url=request.full_url, method=request.get_method(),
                    key=request.get_header("X-goog-api-key"), body=json.loads(request.data))
        return Resp(json.dumps(reply()).encode())

    monkeypatch.setattr(gemini.urllib.request, "urlopen", fake_urlopen)
    assert gemini.ask_json("hi", {}) == {"ok": True}
    assert seen["timeout"] == 300 and seen["method"] == "POST" and seen["key"] == KEY
    assert seen["body"]["contents"][0]["parts"][0]["text"] == "hi"


# ── key ────────────────────────────────────────────────────────────

def test_missing_key_names_the_env_var_and_the_secret(monkeypatch):
    monkeypatch.delenv("GENIUSCUT_GEMINI_API_KEY", raising=False)
    import subprocess

    def run(cmd, **kwargs):
        return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="PERMISSION_DENIED")

    with pytest.raises(secrets.MissingKeyError) as e:
        secrets.gemini_api_key(run=run, gcloud="gcloud")
    assert "GENIUSCUT_GEMINI_API_KEY" in str(e.value) and "GOOGLE_API_KEY" in str(e.value)
    assert "agent-georg" in str(e.value)


def test_key_falls_back_to_the_google_api_key_secret(monkeypatch):
    monkeypatch.delenv("GENIUSCUT_GEMINI_API_KEY", raising=False)
    import subprocess
    calls = []

    def run(cmd, **kwargs):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout="AIza-gsm\n", stderr="")

    assert secrets.gemini_api_key(run=run, gcloud="gcloud") == "AIza-gsm"
    assert "--secret=GOOGLE_API_KEY" in calls[0] and "--project=agent-georg" in calls[0]


# ── usage and the budget ───────────────────────────────────────────

def test_usage_counts_thinking_as_output_and_is_metered():
    usage = {"promptTokenCount": 1000, "candidatesTokenCount": 300, "thoughtsTokenCount": 700}
    with spend.meter(kind="trim") as m:
        gemini.ask_json("hi", {}, client=Transport(reply(usage=usage)))
    assert (m.input_tokens, m.output_tokens, m.model) == (1000, 1000, "gemini-3.7-flash")
    assert m.usd == pytest.approx(1000 * 0.75e-6 + 1000 * 3.75e-6)
    row = json.loads(spend.ledger_path().read_text(encoding="utf-8").splitlines()[0])
    assert row["kind"] == "trim" and row["output_tokens"] == 1000


def test_usage_without_thoughts_or_metadata():
    with spend.meter() as m:
        gemini.ask_json("hi", {}, client=Transport({"candidates": [
            {"content": {"parts": [{"text": "{}"}]}, "finishReason": "STOP"}]}))
    assert (m.input_tokens, m.output_tokens) == (0, 0)


def test_a_cut_off_reply_is_still_billed():
    usage = {"promptTokenCount": 10, "candidatesTokenCount": 16000}
    with spend.meter() as m, pytest.raises(llm.LLMError):
        gemini.ask_json("hi", {}, client=Transport(reply("{", finish="MAX_TOKENS", usage=usage)))
    assert m.output_tokens == 16000


def test_budget_gate_blocks_before_any_http_call(monkeypatch):
    monkeypatch.setenv("GENIUSCUT_MONTHLY_LIMIT_USD", "0.01")
    t = Transport()
    with pytest.raises(spend.BudgetExceeded):
        gemini.ask_json("hi", {}, client=t, max_tokens=16000)  # worst case ≈ $0.06
    assert t.calls == []
