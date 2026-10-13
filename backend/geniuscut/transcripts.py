"""Transcript jobs for the assistant: a range's words without a full Analyse.

A job is keyed by what it transcribes (the audio sources and the range length, not where the
range sits on the timeline), so asking again returns the cached words or joins the running job.
One worker thread runs the jobs in order; a job asked for while the speech model loads waits in
the queue and reports "loading". Words are range-relative seconds; the panel's bridge converts.
"""

import hashlib
import json
import logging
import queue
import threading
import time
from typing import Callable

from geniuscut.models import TranscriptJob, TranscriptRequest, Word
from geniuscut.stt import Transcriber

log = logging.getLogger(__name__)

POLL_S = 0.5  # how often a queued job checks whether the speech model is ready
MAX_WAIT_S = 60.0  # longest a GET long-polls, so a tool call never blocks much past a minute


def key_for(req: TranscriptRequest) -> str:
    sources = [[s.media_path, s.in_s, s.offset_s, s.duration_s] for s in req.audio]
    blob = json.dumps({"audio": sources, "duration_s": req.duration_s})
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


class OneAtATime:
    """A transcriber whose transcribe() holds the shared Whisper lock (one run at a time)."""

    def __init__(self, transcriber: Transcriber, lock: threading.Lock):
        self._t, self._lock = transcriber, lock

    def __getattr__(self, name):
        return getattr(self._t, name)

    def transcribe(self, *args, **kwargs):
        with self._lock:
            return self._t.transcribe(*args, **kwargs)


class _Job:
    def __init__(self, job_id: str, req: TranscriptRequest):
        self.id, self.req = job_id, req
        self.status = "queued"  # queued | done | error
        self.words: list[Word] | None = None
        self.error: str | None = None
        self._finished = threading.Event()

    def wait(self, seconds: float) -> bool:
        return self._finished.wait(seconds)

    def finish(self) -> None:
        self._finished.set()


class Jobs:
    def __init__(
        self,
        transcribe: Callable[[TranscriptRequest, Transcriber], list[Word]],
        transcriber: Callable[[], Transcriber | None],
        load_error: Callable[[], str | None] = lambda: None,
    ):
        self._transcribe, self._transcriber, self._load_error = transcribe, transcriber, load_error
        self._jobs: dict[str, _Job] = {}
        self._lock = threading.Lock()
        self._queue: queue.Queue[_Job] = queue.Queue()
        self._worker: threading.Thread | None = None

    def submit(self, req: TranscriptRequest) -> TranscriptJob:
        """The cached transcript, the job already running for it, or a new job."""
        key = key_for(req)
        with self._lock:
            job = self._jobs.get(key)
            if job is None or job.status == "error":
                job = self._jobs[key] = _Job(key, req)
                self._queue.put(job)
                if self._worker is None:
                    self._worker = threading.Thread(target=self._work, name="transcripts", daemon=True)
                    self._worker.start()
        return self._view(job)

    def get(self, job_id: str, wait_s: float = 0.0) -> TranscriptJob | None:
        job = self._jobs.get(job_id)
        if job is None:
            return None
        wait_s = min(max(wait_s, 0.0), MAX_WAIT_S)
        if wait_s and job.status == "queued":
            job.wait(wait_s)
        return self._view(job)

    def _view(self, job: _Job) -> TranscriptJob:
        if job.status == "done":
            return TranscriptJob(id=job.id, status="done", progress=1.0, words=job.words)
        if job.status == "error":
            return TranscriptJob(id=job.id, status="error", error=job.error)
        return TranscriptJob(id=job.id, status="loading" if self._transcriber() is None else "running")

    def _work(self) -> None:
        while True:
            job = self._queue.get()
            try:
                t = self._transcriber()
                while t is None:
                    err = self._load_error()
                    if err:
                        raise RuntimeError(f"The speech model failed to load ({err}). Ask again in a minute.")
                    time.sleep(POLL_S)
                    t = self._transcriber()
                job.words = self._transcribe(job.req, t)
                job.status = "done"
            except Exception as e:  # noqa: BLE001 — reported through the job, never lost
                log.exception("Transcript job failed")
                job.error = str(e) or type(e).__name__
                job.status = "error"
            finally:
                job.finish()
