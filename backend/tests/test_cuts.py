import json
import subprocess
from types import SimpleNamespace

import pytest

from geniuscut import claude, cuts, secrets
from geniuscut.library import FewShot
from geniuscut.models import Word

WORDS = [Word(w=w, start=s, end=e) for w, s, e in [
    ("So,", 0.00, 0.26), ("um,", 0.40, 0.62), ("the", 0.80, 0.90), ("thing", 0.90, 1.10),
    ("is,", 1.10, 1.30), ("uh,", 1.60, 1.80), ("we", 2.00, 2.10), ("we", 2.30, 2.40),
    ("sell", 2.40, 2.70), ("plans.", 2.70, 3.10),
]]


class FakeClient:
    """Stands in for anthropic.Anthropic(); records the request, returns a canned reply."""

    def __init__(self, payload=None, stop_reason="end_turn", text=None):
        self.requests = []
        body = text if text is not None else json.dumps(payload)
        self._response = SimpleNamespace(stop_reason=stop_reason, stop_details=None,
                                         content=[SimpleNamespace(type="text", text=body)])
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        self.requests.append(kwargs)
        return self._response


# ── claude.ask_json ────────────────────────────────────────────────

def test_ask_json_sends_schema_effort_and_fallbacks():
    fake = FakeClient({"ok": True})
    assert claude.ask_json("hi", {"type": "object"}, client=fake) == {"ok": True}
    req = fake.requests[0]
    assert req["model"] == "claude-opus-5-5"
    assert req["output_config"]["format"] == {"type": "json_schema", "schema": {"type": "object"}}
    assert req["output_config"]["effort"] in {"low", "medium", "high", "xhigh", "max"}
    assert req["fallbacks"] == "default" and "server-side-fallback-2026-07-01" in req["betas"]
    assert "tool_choice" not in req  # forced tool use 400s on this model


def test_ask_json_raises_on_refusal_and_truncation():
    with pytest.raises(claude.ClaudeError, match="declined"):
        claude.ask_json("hi", {}, client=FakeClient({}, stop_reason="refusal"))
    with pytest.raises(claude.ClaudeError, match="cut off"):
        claude.ask_json("hi", {}, client=FakeClient({}, stop_reason="max_tokens"))


# ── cuts.propose_cuts ──────────────────────────────────────────────

def test_maps_word_index_ranges_to_exact_word_timings():
    fake = FakeClient({"cuts": [
        {"start_idx": 0, "end_idx": 1, "reason": "filler"},
        {"start_idx": 5, "end_idx": 5, "reason": "filler"},
        {"start_idx": 6, "end_idx": 6, "reason": "false start"},
    ]})
    result = cuts.propose_cuts(WORDS, FewShot(None, []), client=fake)
    assert [(c.start, c.end, c.text, c.reason) for c in result] == [
        (0.00, 0.62, "So, um,", "filler"),
        (1.60, 1.80, "uh,", "filler"),
        (2.00, 2.10, "we", "false start"),
    ]


def test_rejects_out_of_range_backwards_and_overlapping_ranges():
    fake = FakeClient({"cuts": [
        {"start_idx": 0, "end_idx": 1, "reason": "filler"},
        {"start_idx": 1, "end_idx": 2, "reason": "overlaps the first"},
        {"start_idx": 7, "end_idx": 6, "reason": "backwards"},
        {"start_idx": 8, "end_idx": 99, "reason": "out of range"},
        {"start_idx": -1, "end_idx": 0, "reason": "negative"},
        {"start_idx": 5, "end_idx": 5, "reason": "filler"},
    ]})
    result = cuts.propose_cuts(WORDS, FewShot(None, []), client=fake)
    assert [(c.text, c.reason) for c in result] == [("So, um,", "filler"), ("uh,", "filler")]


def test_accepts_ranges_returned_out_of_order():
    fake = FakeClient({"cuts": [
        {"start_idx": 5, "end_idx": 5, "reason": "filler"},
        {"start_idx": 0, "end_idx": 1, "reason": "filler"},
    ]})
    result = cuts.propose_cuts(WORDS, FewShot(None, []), client=fake)
    assert [c.start for c in result] == [0.00, 1.60]


def test_prompt_numbers_words_and_includes_style_context():
    fake = FakeClient({"cuts": []})
    cuts.propose_cuts(WORDS, FewShot("- Always cut 'um'.", []), instruction="tighten it", client=fake)
    prompt = fake.requests[0]["messages"][0]["content"]
    assert "[0] So," in prompt and "[9] plans." in prompt
    assert "- Always cut 'um'." in prompt
    assert "tighten it" in prompt


def test_no_words_means_no_call_and_no_cuts():
    fake = FakeClient({"cuts": [{"start_idx": 0, "end_idx": 0, "reason": "x"}]})
    assert cuts.propose_cuts([], FewShot(None, []), client=fake) == []
    assert fake.requests == []


# ── secrets ────────────────────────────────────────────────────────

def test_key_comes_from_the_environment_first(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-env")
    assert secrets.anthropic_api_key(run=lambda *a, **k: pytest.fail("gcloud must not run")) == "sk-env"


def test_key_falls_back_to_secret_manager(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    calls = []

    def run(cmd, **kwargs):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout="sk-gsm\n", stderr="")

    assert secrets.anthropic_api_key(run=run, gcloud="gcloud") == "sk-gsm"
    assert "--project=agent-georg" in calls[0] and "--secret=ANTHROPIC_API_KEY" in calls[0]


def test_missing_key_says_how_to_fix_it(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    def run(cmd, **kwargs):
        return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="PERMISSION_DENIED")

    with pytest.raises(secrets.MissingKeyError) as e:
        secrets.anthropic_api_key(run=run, gcloud="gcloud")
    assert "ANTHROPIC_API_KEY" in str(e.value) and "gcloud auth login" in str(e.value)


def _raising_client(exc):
    def create(**kwargs):
        raise exc
    return SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=create)))


def test_api_errors_become_readable_claude_errors():
    import anthropic
    import httpx

    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    body = {"type": "error", "error": {"type": "invalid_request_error",
                                       "message": "Your credit balance is too low to access the Anthropic API."}}
    billing = anthropic.BadRequestError("400", response=httpx.Response(400, request=req, json=body), body=body)
    with pytest.raises(claude.ClaudeError, match="credit balance is too low"):
        claude.ask_json("hi", {}, client=_raising_client(billing))

    with pytest.raises(claude.ClaudeError, match="reach"):
        claude.ask_json("hi", {}, client=_raising_client(anthropic.APIConnectionError(request=req)))
