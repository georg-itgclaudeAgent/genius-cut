"""Transcript jobs for the assistant (plan task 5): POST /transcript, GET /transcript/{id}?wait=."""

import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from geniuscut import audio, config, transcripts, trim
from geniuscut.models import TranscriptRequest, TrimRequest, Word
from server import create_app

WORDS = [Word(w="hello", start=0.1, end=0.5), Word(w="there", start=0.6, end=1.0)]
REQ = {"duration_s": 4.0, "range_start_seq_s": 100.0,
       "audio": [{"media_path": "C:/f/take.mp4", "in_s": 10.0}]}
TRIM_REQ = dict(media_path="C:/f/take.mp4", in_s=10.0, out_s=12.0, clip_start_s=0.0, cut_pauses=False)


class Transcriber:
    """Counts calls and how many run at once; `gate` (when given) holds every call until set."""
    device = "cuda"

    def __init__(self, gate: threading.Event | None = None, fail: Exception | None = None):
        self.gate, self.fail = gate, fail
        self.calls = 0
        self.active = self.max_active = 0
        self.started = threading.Event()
        self._count = threading.Lock()

    def transcribe(self, wav):
        with self._count:
            self.calls += 1
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        self.started.set()
        try:
            if self.gate is not None:
                assert self.gate.wait(5), "test gate never opened"
            if self.fail is not None:
                raise self.fail
            return WORDS
        finally:
            with self._count:
                self.active -= 1


def fake_extract(media_path, in_s, out_s, out_dir=None):
    out = Path(out_dir) / "span.wav"
    out.write_bytes(b"RIFF")
    return out


@pytest.fixture(autouse=True)
def _fast_poll(monkeypatch):
    monkeypatch.setattr(transcripts, "POLL_S", 0.01)


def app(tmp_path, transcriber, **kw):
    token = config.get_or_create_token(tmp_path)
    kw.setdefault("extract", fake_extract)
    a = create_app(token=token, stt_device=lambda: "cuda", transcriber=transcriber,
                   library_dir=tmp_path / "library", propose=lambda w, f, i: [], **kw)
    return TestClient(a, base_url="http://127.0.0.1:8791"), {"Authorization": f"Bearer {token}"}


def finish(c, auth, job_id):
    r = c.get(f"/transcript/{job_id}", params={"wait": 5}, headers=auth)
    assert r.status_code == 200
    return r.json()


def test_api_version_is_7_for_graphics():
    assert config.API_VERSION == 7


# ── transcribe_range ───────────────────────────────────────────────

def test_transcribe_range_returns_range_relative_words_and_cleans_up(tmp_path):
    seen = []

    def extract(media_path, in_s, out_s, out_dir=None):
        seen.append((media_path, in_s, out_s, Path(out_dir)))
        return fake_extract(media_path, in_s, out_s, out_dir)

    words, env = trim.transcribe_range(TranscriptRequest(**REQ), Transcriber(), extract=extract)
    assert words == WORDS
    assert env is None  # not a real wav: no envelope, as in run_trim
    assert [(m, i, o) for m, i, o, _ in seen] == [("C:/f/take.mp4", 10.0, 14.0)]
    assert not seen[0][3].exists()  # the temp folder is gone


def test_a_trim_request_is_a_transcript_request():
    # The bridge reuses the panel's trim request; extra fields (prompt, ...) are ignored.
    req = TranscriptRequest(**TrimRequest(**TRIM_REQ).model_dump())
    assert req.duration_s == 2.0 and req.audio[0].in_s == 10.0


def test_a_source_outside_the_range_is_refused(tmp_path):
    t = Transcriber()
    c, auth = app(tmp_path, lambda: t)
    bad = {**REQ, "audio": [{"media_path": "C:/f/take.mp4", "in_s": 10.0, "offset_s": 3.0, "duration_s": 2.0}]}
    assert c.post("/transcript", json=bad, headers=auth).status_code == 422


# ── job lifecycle ──────────────────────────────────────────────────

def test_a_job_runs_then_reports_its_words(tmp_path):
    gate = threading.Event()
    t = Transcriber(gate)
    c, auth = app(tmp_path, lambda: t)
    r = c.post("/transcript", json=REQ, headers=auth)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "running" and body["words"] is None and body["progress"] == 0
    gate.set()
    done = finish(c, auth, body["id"])
    assert done["status"] == "done" and done["progress"] == 1
    assert done["words"] == [w.model_dump() for w in WORDS]  # range-relative: no 100 s added


def test_a_finished_transcript_is_served_from_the_cache(tmp_path):
    t = Transcriber()
    c, auth = app(tmp_path, lambda: t)
    first = c.post("/transcript", json=REQ, headers=auth).json()
    finish(c, auth, first["id"])
    # Same audio and range, placed elsewhere on the timeline: same transcript.
    again = c.post("/transcript", json={**REQ, "range_start_seq_s": 7.0}, headers=auth).json()
    assert again["id"] == first["id"] and again["status"] == "done"
    assert again["words"] == [w.model_dump() for w in WORDS]
    assert t.calls == 1


def test_a_different_range_is_a_different_job(tmp_path):
    t = Transcriber()
    c, auth = app(tmp_path, lambda: t)
    a = c.post("/transcript", json=REQ, headers=auth).json()
    b = c.post("/transcript", json={**REQ, "audio": [{"media_path": "C:/f/take.mp4", "in_s": 11.0}]},
               headers=auth).json()
    assert a["id"] != b["id"]
    finish(c, auth, a["id"]), finish(c, auth, b["id"])
    assert t.calls == 2


def test_asking_again_while_running_joins_the_same_job(tmp_path):
    gate = threading.Event()
    t = Transcriber(gate)
    c, auth = app(tmp_path, lambda: t)
    a = c.post("/transcript", json=REQ, headers=auth).json()
    b = c.post("/transcript", json=REQ, headers=auth).json()
    assert a["id"] == b["id"]
    gate.set()
    finish(c, auth, a["id"])
    assert t.calls == 1


def test_wait_returns_when_the_time_is_up_and_the_job_still_runs(tmp_path):
    gate = threading.Event()
    t = Transcriber(gate)
    c, auth = app(tmp_path, lambda: t)
    job = c.post("/transcript", json=REQ, headers=auth).json()
    t0 = time.monotonic()
    r = c.get(f"/transcript/{job['id']}", params={"wait": 0.3}, headers=auth).json()
    took = time.monotonic() - t0
    assert r["status"] == "running" and 0.25 <= took < 3
    gate.set()
    assert finish(c, auth, job["id"])["status"] == "done"


def test_wait_is_capped_at_60_seconds(tmp_path, monkeypatch):
    waits = []
    gate = threading.Event()
    t = Transcriber(gate)
    c, auth = app(tmp_path, lambda: t)
    job = c.post("/transcript", json=REQ, headers=auth).json()
    monkeypatch.setattr(transcripts._Job, "wait", lambda self, s: waits.append(s) or False)
    c.get(f"/transcript/{job['id']}", params={"wait": 600}, headers=auth)
    assert waits == [60]
    gate.set()


def test_an_unknown_job_is_404_and_routes_need_the_token(tmp_path):
    c, auth = app(tmp_path, lambda: Transcriber())
    assert c.get("/transcript/nope", headers=auth).status_code == 404
    assert c.post("/transcript", json=REQ).status_code == 401
    assert c.get("/transcript/nope").status_code == 401


def test_a_failed_transcription_reports_error_and_can_be_asked_again(tmp_path):
    t = Transcriber(fail=RuntimeError("CUDA out of memory"))
    c, auth = app(tmp_path, lambda: t)
    job = c.post("/transcript", json=REQ, headers=auth).json()
    r = finish(c, auth, job["id"])
    assert r["status"] == "error" and "CUDA out of memory" in r["error"] and r["words"] is None
    t.fail = None
    again = c.post("/transcript", json=REQ, headers=auth).json()
    assert again["status"] == "running"
    assert finish(c, auth, again["id"])["status"] == "done"


def test_an_ffmpeg_failure_is_an_error_status(tmp_path):
    def broken(*a, **kw):
        raise audio.FfmpegError("ffmpeg couldn't read C:/f/take.mp4")

    c, auth = app(tmp_path, lambda: Transcriber(), extract=broken)
    job = c.post("/transcript", json=REQ, headers=auth).json()
    r = finish(c, auth, job["id"])
    assert r["status"] == "error" and "couldn't read" in r["error"]


# ── while the speech model loads ───────────────────────────────────

def test_a_job_asked_for_while_whisper_loads_is_queued_and_reports_loading(tmp_path):
    t = Transcriber()
    ready = {"t": None}
    c, auth = app(tmp_path, lambda: ready["t"])
    job = c.post("/transcript", json=REQ, headers=auth)
    assert job.status_code == 200 and job.json()["status"] == "loading"
    r = c.get(f"/transcript/{job.json()['id']}", params={"wait": 0.1}, headers=auth).json()
    assert r["status"] == "loading" and t.calls == 0
    ready["t"] = t
    assert finish(c, auth, job.json()["id"])["status"] == "done"
    assert t.calls == 1


def test_a_failed_model_load_is_503_and_retried_like_trim(tmp_path):
    retries = []
    c, auth = app(tmp_path, lambda: None, load_error=lambda: "disk full",
                  retry_load=lambda: retries.append(1))
    r = c.post("/transcript", json=REQ, headers=auth)
    assert r.status_code == 503 and "disk full" in r.json()["detail"]
    assert retries == [1]


def test_a_queued_job_fails_if_the_model_load_fails(tmp_path):
    state = {"err": None}
    c, auth = app(tmp_path, lambda: None, load_error=lambda: state["err"])
    job = c.post("/transcript", json=REQ, headers=auth).json()
    assert job["status"] == "loading"
    state["err"] = "disk full"
    r = finish(c, auth, job["id"])
    assert r["status"] == "error" and "disk full" in r["error"]


# ── one Whisper run at a time ──────────────────────────────────────

def test_a_job_and_a_trim_never_transcribe_at_once(tmp_path):
    gate = threading.Event()
    t = Transcriber(gate)
    c, auth = app(tmp_path, lambda: t)
    job = c.post("/transcript", json=REQ, headers=auth).json()
    assert t.started.wait(5)
    trim_result = {}
    th = threading.Thread(target=lambda: trim_result.update(r=c.post("/trim", json=TRIM_REQ, headers=auth)))
    th.start()
    time.sleep(0.3)
    assert t.calls == 1  # the trim is waiting for the job's Whisper run
    gate.set()
    th.join(5)
    assert trim_result["r"].status_code == 200
    assert finish(c, auth, job["id"])["status"] == "done"
    assert t.calls == 2 and t.max_active == 1


def test_a_trim_holds_whisper_and_the_job_waits(tmp_path):
    gate = threading.Event()
    t = Transcriber(gate)
    c, auth = app(tmp_path, lambda: t)
    trim_result = {}
    th = threading.Thread(target=lambda: trim_result.update(r=c.post("/trim", json=TRIM_REQ, headers=auth)))
    th.start()
    assert t.started.wait(5)
    job = c.post("/transcript", json=REQ, headers=auth).json()
    time.sleep(0.3)
    assert t.calls == 1
    gate.set()
    th.join(5)
    assert trim_result["r"].status_code == 200
    assert finish(c, auth, job["id"])["status"] == "done"
    assert t.max_active == 1
