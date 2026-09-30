"""Regression tests for the Tasks 1-8 final review (I1-I7)."""

import math
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from geniuscut import config, library, stt, trim
from geniuscut.models import CutSpan, TrimRequest, Word
from server import create_app

WORDS = [Word(w="hello", start=0.1, end=0.5), Word(w="there", start=0.6, end=1.0)]


class FakeTranscriber:
    device = "cuda"

    def transcribe(self, wav):
        return WORDS


def fake_extract(media_path, in_s, out_s, out_dir=None):
    out = Path(out_dir) / "span.wav"
    out.write_bytes(b"RIFF")
    return out


REQ = dict(media_path="C:/f/take.mp4", in_s=10.0, out_s=12.0, clip_start_s=0.0)


def app(tmp_path, *, transcriber=lambda: FakeTranscriber(), propose=lambda w, f, i: [], **kw):
    token = config.get_or_create_token(tmp_path)
    a = create_app(token=token, stt_device=lambda: "cuda", transcriber=transcriber,
                   library_dir=tmp_path / "library", propose=propose, extract=fake_extract, **kw)
    return TestClient(a, base_url="http://127.0.0.1:8791"), {"Authorization": f"Bearer {token}"}


# ── I1: never return "keep nothing" ────────────────────────────────

def test_i1_cutting_the_whole_clip_is_refused_not_returned(tmp_path):
    everything = [CutSpan(start=0.0, end=2.5, text="hello there", reason="tangent")]
    with pytest.raises(trim.TrimRefused, match="whole clip"):
        trim.run_trim(TrimRequest(**REQ), FakeTranscriber(), tmp_path,
                      propose=lambda w, f, i: everything, extract=fake_extract)
    c, auth = app(tmp_path, propose=lambda w, f, i: everything)
    r = c.post("/trim", json=REQ, headers=auth)
    assert r.status_code == 422 and "whole clip" in r.json()["detail"]


def test_i1_heavy_cuts_come_back_flagged(tmp_path):
    heavy = [CutSpan(start=0.0, end=1.5, text="hello", reason="tangent")]
    r = trim.run_trim(TrimRequest(**REQ), FakeTranscriber(), tmp_path,
                      propose=lambda w, f, i: heavy, extract=fake_extract)
    assert r.cut_fraction == pytest.approx(0.75)
    assert r.warning and "75%" in r.warning


def test_i1_normal_cuts_carry_no_warning(tmp_path):
    light = [CutSpan(start=0.1, end=0.5, text="hello", reason="filler")]
    r = trim.run_trim(TrimRequest(**REQ), FakeTranscriber(), tmp_path,
                      propose=lambda w, f, i: light, extract=fake_extract)
    assert r.warning is None


# ── I2: a failed model load is reported, and can be retried ────────

def test_i2_failed_load_is_an_error_everywhere_and_retries(tmp_path):
    retries = []
    c, auth = app(tmp_path, transcriber=lambda: None,
                  load_error=lambda: "disk full during download", retry_load=lambda: retries.append(1))
    health = c.get("/health").json()
    assert health["status"] == "error" and "disk full" in health["error"]
    r = c.post("/trim", json=REQ, headers=auth)
    assert r.status_code == 503
    assert "disk full" in r.json()["detail"] and "loading" not in r.json()["detail"].lower()
    assert retries == [1]


# ── I3: a GPU failure mid-request falls back to the CPU ────────────

def test_i3_gpu_failure_during_transcription_retries_on_cpu(tmp_path):
    class Model:
        def __init__(self, name, device, compute_type):
            self.device = device

        def transcribe(self, audio, **kw):
            if self.device == "cuda":
                raise RuntimeError("CUDA failed with error out of memory")
            w = SimpleNamespace(word=" hi", start=0.0, end=0.4)
            return iter([SimpleNamespace(words=[w])]), None

    wav = tmp_path / "a.wav"
    import wave
    with wave.open(str(wav), "wb") as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(16000); f.writeframes(b"\x00\x00" * 1600)
    t = stt.FasterWhisperTranscriber("x", model_factory=Model, cuda_ready=lambda: True, warm_up=False)
    assert t.device == "cuda"
    words = t.transcribe(wav)
    assert [w.w for w in words] == ["hi"]
    assert t.device == "cpu" and "out of memory" in t.cuda_error


# ── I4: loopback only, even through DNS rebinding ──────────────────

def test_i4_requests_with_a_foreign_host_header_are_rejected(tmp_path):
    c, _ = app(tmp_path)
    assert c.get("/health", headers={"Host": "127.0.0.1:8791"}).status_code == 200
    assert c.get("/health", headers={"Host": "evil.example"}).status_code == 400


# ── I5: first-run token race ───────────────────────────────────────

def test_i5_an_existing_token_is_never_overwritten(tmp_path, monkeypatch):
    (tmp_path / "token").write_text("already-written-by-the-other-process", encoding="utf-8")
    real_exists = Path.exists
    # Simulate the race: this process checked before the other one finished writing.
    monkeypatch.setattr(Path, "exists", lambda p: False if p.name == "token" else real_exists(p))
    assert config.get_or_create_token(tmp_path) == "already-written-by-the-other-process"


# ── I6: bad times are a 422, not a 500 ─────────────────────────────

@pytest.mark.parametrize("bad", [
    dict(in_s=5.0, out_s=5.0), dict(in_s=6.0, out_s=5.0), dict(in_s=-1.0, out_s=5.0),
    dict(in_s=math.nan, out_s=5.0), dict(in_s=0.0, out_s=math.inf),
])
def test_i6_invalid_spans_are_rejected(bad):
    with pytest.raises(ValidationError):
        TrimRequest(**{**REQ, **bad})


def test_i6_invalid_span_over_http_is_422(tmp_path):
    c, auth = app(tmp_path)
    assert c.post("/trim", json={**REQ, "in_s": 9.0, "out_s": 3.0}, headers=auth).status_code == 422


# ── I7: one broken library file doesn't break every trim ───────────

def test_i7_corrupt_or_naive_examples_are_skipped(tmp_path):
    lib = tmp_path / "library"
    good = library.add_example(WORDS, "hello there", "a.mp4", lib, now="2026-09-30T10:00:00+08:00")
    (lib / "examples" / "broken.json").write_text("{not json", encoding="utf-8")
    naive = good.model_copy(update={"id": "naive", "created": "2026-09-29T09:00:00"})
    (lib / "examples" / "naive.json").write_text(naive.model_dump_json(), encoding="utf-8")
    ids = [e.id for e in library.list_examples(lib)]
    assert ids == [good.id, "naive"]
    c, auth = app(tmp_path)
    assert c.post("/trim", json=REQ, headers=auth).status_code == 200


# ── panel review I4: Retry must be able to recover a failed load ───

def test_reload_triggers_a_model_retry(tmp_path):
    retries = []
    c, auth = app(tmp_path, transcriber=lambda: None,
                  load_error=lambda: "network blip", retry_load=lambda: retries.append(1))
    assert c.post("/reload").status_code == 401
    r = c.post("/reload", headers=auth)
    assert r.status_code == 202 and retries == [1]
