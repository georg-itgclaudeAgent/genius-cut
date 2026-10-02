from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from geniuscut import trim
from geniuscut.config import get_or_create_token
from geniuscut.models import CutSpan, TrimRequest, Word
from server import create_app

WORDS = [Word(w="So,", start=0.0, end=0.3), Word(w="um,", start=0.5, end=0.8),
         Word(w="hello", start=1.0, end=1.4), Word(w="uh", start=2.0, end=2.2),
         Word(w="there.", start=2.5, end=3.0)]
CUTS = [CutSpan(start=0.5, end=0.8, text="um,", reason="filler"),
        CutSpan(start=2.0, end=2.2, text="uh", reason="filler")]


class FakeTranscriber:
    device = "cuda"

    def __init__(self):
        self.seen = None

    def transcribe(self, wav):
        self.seen = wav
        return WORDS


def fake_extract(media_path, in_s, out_s, out_dir=None):
    out = Path(out_dir) / "span.wav"
    out.write_bytes(b"RIFF")
    return out


# These tests are about Claude's cuts and the clock mapping; pause cuts are tested separately.
REQ = TrimRequest(media_path="C:/footage/take3.mp4", in_s=10.0, out_s=14.0, clip_start_s=100.0, prompt="trim it",
                  cut_pauses=False)


def run(tmp_path, cuts=CUTS):
    return trim.run_trim(REQ, FakeTranscriber(), tmp_path, propose=lambda w, f, i: cuts, extract=fake_extract)


def test_kept_spans_are_the_complement_of_the_cuts_in_source_time(tmp_path):
    r = run(tmp_path)
    assert [(s.start, s.end) for s in r.kept_spans_source] == [(10.0, 10.5), (10.8, 12.0), (12.2, 14.0)]


def test_kept_spans_sum_to_span_minus_cut_total(tmp_path):
    r = run(tmp_path)
    kept = sum(s.end - s.start for s in r.kept_spans_source)
    assert kept == pytest.approx((REQ.out_s - REQ.in_s) - (0.3 + 0.2))


def test_sequence_time_is_clip_start_plus_word_time_with_no_in_point_term(tmp_path):
    r = run(tmp_path)
    assert [(c.start_seq_s, c.end_seq_s) for c in r.cuts] == [(100.5, 100.8), (102.0, 102.2)]
    assert r.stt_device == "cuda"


def test_no_cuts_keeps_the_whole_span(tmp_path):
    r = run(tmp_path, cuts=[])
    assert [(s.start, s.end) for s in r.kept_spans_source] == [(10.0, 14.0)]


def test_cut_touching_the_edges_leaves_no_zero_length_spans(tmp_path):
    r = run(tmp_path, cuts=[CutSpan(start=0.0, end=0.3, text="So,", reason="filler"),
                            CutSpan(start=3.5, end=4.0, text="", reason="tangent")])
    assert [(s.start, s.end) for s in r.kept_spans_source] == [(10.3, 13.5)]


def test_temp_audio_is_cleaned_up(tmp_path):
    t = FakeTranscriber()
    trim.run_trim(REQ, t, tmp_path, propose=lambda w, f, i: [], extract=fake_extract)
    assert not Path(t.seen).exists()


# ── HTTP ───────────────────────────────────────────────────────────

def api(tmp_path, transcriber=None):
    token = get_or_create_token(tmp_path)
    app = create_app(token=token, stt_device=lambda: "cuda", transcriber=lambda: transcriber,
                     library_dir=tmp_path / "library",
                     propose=lambda w, f, i: CUTS, extract=fake_extract, llm=lambda p: "- Cut fillers.")
    return TestClient(app, base_url="http://127.0.0.1:8791"), {"Authorization": f"Bearer {token}"}


def test_trim_endpoint_returns_words_cuts_and_kept_spans(tmp_path):
    c, auth = api(tmp_path, FakeTranscriber())
    r = c.post("/trim", json=REQ.model_dump(), headers=auth)
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["words"]) == 5 and len(body["cuts"]) == 2
    assert body["kept_spans_source"][0] == {"start": 10.0, "end": 10.5}


def test_trim_while_the_model_is_still_loading_is_503(tmp_path):
    c, auth = api(tmp_path, transcriber=None)
    r = c.post("/trim", json=REQ.model_dump(), headers=auth)
    assert r.status_code == 503
    assert "loading" in r.json()["detail"].lower()


def test_library_add_list_and_summarise(tmp_path):
    c, auth = api(tmp_path, FakeTranscriber())
    add = c.post("/library/examples", headers=auth, json={
        "raw_words": [w.model_dump() for w in WORDS], "final_text": "So, hello there.", "source_clip": "take3.mp4"})
    assert add.status_code == 200, add.text
    assert [s["text"] for s in add.json()["removed_spans"]] == ["um,", "uh"]
    listing = c.get("/library", headers=auth).json()
    assert len(listing["examples"]) == 1 and listing["summary"] is None
    summary = c.post("/library/summarize", headers=auth)
    assert summary.json()["summary"] == "- Cut fillers."
    assert c.get("/library", headers=auth).json()["summary"] == "- Cut fillers."


def test_missing_api_key_is_a_clear_error_not_a_500(tmp_path):
    from geniuscut import secrets as gsecrets

    def no_key(words, fewshot, instruction):
        raise gsecrets.MissingKeyError("No Anthropic API key. Set the ANTHROPIC_API_KEY environment variable.")

    token = get_or_create_token(tmp_path)
    app = create_app(token=token, stt_device=lambda: "cuda", transcriber=lambda: FakeTranscriber(),
                     library_dir=tmp_path / "library", propose=no_key, extract=fake_extract)
    r = TestClient(app, base_url="http://127.0.0.1:8791").post("/trim", json=REQ.model_dump(), headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 503
    assert "ANTHROPIC_API_KEY" in r.json()["detail"]


# ── pause cuts ─────────────────────────────────────────────────────

PAUSEY = [Word(w="So", start=0.1, end=0.4), Word(w="right.", start=0.5, end=0.9),
          Word(w="Anyway", start=3.3, end=3.8)]


class PauseyTranscriber(FakeTranscriber):
    def transcribe(self, wav):
        return PAUSEY


def test_trim_adds_pause_cuts_alongside_claudes(tmp_path):
    r = trim.run_trim(TrimRequest(**{**REQ.model_dump(), "cut_pauses": True}), PauseyTranscriber(), tmp_path,
                      propose=lambda w, f, i: [], extract=fake_extract)
    assert [(c.start, c.end, c.reason) for c in r.cuts] == [(1.15, 3.05, "pause")]
    assert [(s.start, s.end) for s in r.kept_spans_source][-1] == (13.05, 14.0)


def test_trim_can_switch_pause_cuts_off(tmp_path):
    req = TrimRequest(**{**REQ.model_dump(), "cut_pauses": False})
    r = trim.run_trim(req, PauseyTranscriber(), tmp_path, propose=lambda w, f, i: [], extract=fake_extract)
    assert r.cuts == []


def test_a_minimum_pause_too_short_for_breathing_room_is_a_422(tmp_path):
    c, auth = api(tmp_path, FakeTranscriber())
    r = c.post("/trim", json={**REQ.model_dump(), "cut_pauses": True, "min_pause_s": 0.3}, headers=auth)
    assert r.status_code == 422
