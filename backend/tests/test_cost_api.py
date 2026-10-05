"""What each run cost, the month so far, and the 402 when the limit would be passed."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from geniuscut import config, cuts, spend, trim
from geniuscut.library import FewShot
from geniuscut.models import CutSpan, TrimRequest, Word
from server import create_app

WORDS = [Word(w="um", start=0.1, end=0.4), Word(w="hello", start=0.6, end=1.0)]
CUT = [CutSpan(start=0.1, end=0.4, text="um", reason="filler")]
REQ = dict(media_path="C:/f/take.mp4", in_s=10.0, out_s=12.0, clip_start_s=0.0, cut_pauses=False)


class FakeTranscriber:
    device = "cuda"

    def __init__(self, words=WORDS):
        self.words = words

    def transcribe(self, wav):
        return self.words


def fake_extract(media_path, in_s, out_s, out_dir=None):
    out = Path(out_dir) / "span.wav"
    out.write_bytes(b"RIFF")
    return out


def paid_propose(words, fewshot, instruction):
    """Stands in for one Gemini call: records its usage like gemini.py does."""
    spend.record("gemini-2.5-flash-lite", 1_000_000, 500_000)  # $0.10 + $0.20
    return CUT


def app(tmp_path, *, transcriber=FakeTranscriber(), propose=paid_propose, **kw):
    token = config.get_or_create_token(tmp_path)
    a = create_app(token=token, stt_device=lambda: "cuda", transcriber=lambda: transcriber,
                   library_dir=tmp_path / "library", propose=propose, extract=fake_extract, **kw)
    return TestClient(a, base_url="http://127.0.0.1:8791"), {"Authorization": f"Bearer {token}"}


# ── run_trim ───────────────────────────────────────────────────────

def test_run_trim_reports_the_runs_cost_and_the_month(tmp_path):
    spend.record("gemini-2.5-flash-lite", 1_000_000, 0)  # earlier this month: $0.10
    r = trim.run_trim(TrimRequest(**REQ), FakeTranscriber(), tmp_path, propose=paid_propose, extract=fake_extract)
    assert r.cost.model == "gemini-2.5-flash-lite"
    assert (r.cost.input_tokens, r.cost.output_tokens) == (1_000_000, 500_000)
    assert r.cost.usd == pytest.approx(0.30)
    assert r.cost.month_usd == pytest.approx(0.40)
    assert r.cost.limit_usd == 2.0


def test_a_run_with_no_ai_call_costs_nothing(tmp_path):
    r = trim.run_trim(TrimRequest(**{**REQ, "cut_pauses": True}), FakeTranscriber([]), tmp_path,
                      propose=cuts.propose_cuts, extract=fake_extract)
    assert (r.cost.usd, r.cost.input_tokens, r.cost.output_tokens) == (0.0, 0, 0)
    assert r.cost.model == "gemini-3.7-flash"


def test_the_trim_ledger_rows_are_tagged_trim(tmp_path):
    trim.run_trim(TrimRequest(**REQ), FakeTranscriber(), tmp_path, propose=paid_propose, extract=fake_extract)
    assert '"kind": "trim"' in spend.ledger_path().read_text(encoding="utf-8")


def test_propose_cuts_goes_through_gemini_by_default(monkeypatch):
    monkeypatch.setenv("GENIUSCUT_GEMINI_API_KEY", "AIza-test")
    seen = []

    def transport(url, body, headers):
        seen.append(url)
        return {"candidates": [{"content": {"parts": [{"text": '{"cuts": [{"start_idx": 0, "end_idx": 0, '
                                                                 '"reason": "filler"}]}'}]},
                                "finishReason": "STOP"}],
                "usageMetadata": {"promptTokenCount": 300, "candidatesTokenCount": 40}}

    result = cuts.propose_cuts(WORDS, FewShot(None, []), client=transport)
    assert [c.text for c in result] == ["um"]
    assert ":generateContent" in seen[0]


# ── HTTP ───────────────────────────────────────────────────────────

def test_trim_response_carries_cost(tmp_path):
    c, auth = app(tmp_path)
    r = c.post("/trim", json=REQ, headers=auth)
    assert r.status_code == 200, r.text
    cost = r.json()["cost"]
    assert set(cost) == {"model", "input_tokens", "output_tokens", "usd", "month_usd", "limit_usd"}
    assert cost["usd"] == pytest.approx(0.30) and cost["month_usd"] == pytest.approx(0.30)


def test_budget_exceeded_is_402_with_the_message(tmp_path):
    def over(words, fewshot, instruction):
        raise spend.BudgetExceeded("This run could cost up to $0.06, and this month's AI spend is $1.97 of the "
                                   "$2.00 limit. Raise GENIUSCUT_MONTHLY_LIMIT_USD to continue.")

    c, auth = app(tmp_path, propose=over)
    r = c.post("/trim", json=REQ, headers=auth)
    assert r.status_code == 402
    assert r.json()["detail"].startswith("This run could cost up to $0.06")


def test_a_real_gate_refusal_reaches_the_panel_as_402(tmp_path, monkeypatch):
    monkeypatch.setenv("GENIUSCUT_MONTHLY_LIMIT_USD", "0.001")
    monkeypatch.setenv("GENIUSCUT_GEMINI_API_KEY", "AIza-test")
    c, auth = app(tmp_path, propose=cuts.propose_cuts)
    r = c.post("/trim", json=REQ, headers=auth)
    assert r.status_code == 402
    assert "GENIUSCUT_MONTHLY_LIMIT_USD" in r.json()["detail"]


def test_other_llm_errors_are_still_502(tmp_path):
    from geniuscut import llm

    def broken(words, fewshot, instruction):
        raise llm.LLMError("Gemini returned no text.")

    c, auth = app(tmp_path, propose=broken)
    r = c.post("/trim", json=REQ, headers=auth)
    assert r.status_code == 502 and r.json()["detail"] == "Gemini returned no text."


def test_summarize_is_metered(tmp_path):
    def paid_llm(prompt):
        spend.record("gemini-2.5-flash-lite", 0, 100_000)  # $0.04
        return "- Cut fillers."

    c, auth = app(tmp_path, llm=paid_llm)
    c.post("/library/examples", headers=auth, json={
        "raw_words": [w.model_dump() for w in WORDS], "final_text": "hello", "source_clip": "take.mp4"})
    body = c.post("/library/summarize", headers=auth).json()
    assert body["summary"] == "- Cut fillers."
    assert body["cost"]["usd"] == pytest.approx(0.04) and body["cost"]["output_tokens"] == 100_000
    assert '"kind": "summary"' in spend.ledger_path().read_text(encoding="utf-8")


def test_summarize_402(tmp_path):
    def over(prompt):
        raise spend.BudgetExceeded("over")

    c, auth = app(tmp_path, llm=over)
    c.post("/library/examples", headers=auth, json={
        "raw_words": [w.model_dump() for w in WORDS], "final_text": "hello", "source_clip": "take.mp4"})
    assert c.post("/library/summarize", headers=auth).status_code == 402


# ── /health ────────────────────────────────────────────────────────

def test_health_reports_the_ai_block(tmp_path, monkeypatch):
    monkeypatch.setenv("GENIUSCUT_GEMINI_API_KEY", "AIza-must-not-appear")
    spend.record("gemini-2.5-flash-lite", 1_000_000, 0)
    c, _ = app(tmp_path)
    r = c.get("/health")
    assert r.status_code == 200
    ai = r.json()["ai"]
    assert ai["provider"] == "gemini" and ai["model"] == "gemini-3.7-flash"
    assert ai["month_usd"] == pytest.approx(0.10) and ai["limit_usd"] == 2.0
    assert ai["usd_per_minute"] == pytest.approx(spend.estimate_per_minute("gemini-3.7-flash"))
    assert "AIza" not in r.text


def test_health_per_minute_is_null_for_unpriced_models(tmp_path, monkeypatch):
    monkeypatch.setenv("GENIUSCUT_LLM_PROVIDER", "anthropic")
    c, _ = app(tmp_path)
    ai = c.get("/health").json()["ai"]
    assert ai["provider"] == "anthropic" and ai["usd_per_minute"] is None


def test_an_unreadable_ledger_never_fails_health(tmp_path, monkeypatch):
    def boom(now=None):
        raise OSError("disk on fire")

    monkeypatch.setattr(spend, "month_total", boom)
    c, _ = app(tmp_path)
    r = c.get("/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"
    assert r.json()["ai"]["month_usd"] is None


def test_an_unknown_provider_never_fails_health(tmp_path, monkeypatch):
    monkeypatch.setenv("GENIUSCUT_LLM_PROVIDER", "bedrock")
    c, _ = app(tmp_path)
    r = c.get("/health")
    assert r.status_code == 200
    assert r.json()["ai"]["model"] is None and r.json()["ai"]["usd_per_minute"] is None
