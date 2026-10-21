"""Genius Cut local backend — FastAPI on 127.0.0.1:8791.

Run: `.venv/Scripts/python server.py`. Every route except `/health` needs
`Authorization: Bearer <token>`, where the token lives in `<data dir>/token`.
The Whisper model loads in the background, so `/health` answers straight away
(`stt_device: "loading"`) and `/trim` returns 503 until it's ready. A failed load
is reported as `status: "error"` and retried on the next `/trim`.

`POST /transcript` + `GET /transcript/{id}?wait=` serve the assistant transcripts as jobs
(geniuscut/transcripts.py); a lock keeps them and `/trim` to one Whisper run at a time.

The panel calls this through Node's `http` module (CEP `--enable-nodejs`), so no
CORS is configured: a browser page can't reach the API, and the Host check below
also stops DNS-rebinding tricks.

`GET`/`PUT /settings` read and save this editor's settings (where their Anthropic key lives,
the monthly limit; never a key), and `POST /settings/test-key` checks a key source (a pass saves it
and marks setup complete). `/setup/*` and `/usage` serve the Setup and Settings screens; their
request/response shapes are listed at the top of geniuscut/setup.py. `/agent/runs*` run Claude's
side of an instruction (shapes at the top of geniuscut/agent.py). `/graphics/*` report and run the one-time
graphics setup (shapes at the top of geniuscut/graphics.py).

AI errors: a missing key is 503, the monthly spend limit (`spend.BudgetExceeded`) is
402, and any other provider error is 502. `/health` reports the AI provider, model and
the month's spend so far, never a key.
"""

import os as _os
import sys as _sys

# Embeddable Python (the shipped runtime) ignores the script's folder: its ._pth file
# replaces sys.path. Put this folder back so `geniuscut` imports.
_here = _os.path.dirname(_os.path.abspath(__file__))
if _here not in _sys.path:
    _sys.path.insert(0, _here)

import hmac
import os
import logging
import subprocess
import threading
from pathlib import Path
from typing import Callable

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, Field

from geniuscut import (agent, audio, claude, config, cuts, graphics, library, llm, secrets, settings, setup, spend,
                       transcripts, trim)
from geniuscut.llm import LLMError
from geniuscut.models import StyleExample, TranscriptJob, TranscriptRequest, TrimRequest, TrimResponse, Word

log = logging.getLogger("geniuscut")

LOOPBACK_HOSTS = ["127.0.0.1", "localhost"]


def ai_status() -> dict:
    """The `/health` ai block. Never raises: a bad setting or ledger shows as nulls."""
    try:
        provider, model = llm.provider(), llm.model()
    except LLMError:
        provider, model = "unknown", None
    try:
        month_usd = round(spend.month_total(), 6)
    except Exception:  # noqa: BLE001 — health must answer even if the ledger can't be read
        log.exception("Couldn't read the AI spend ledger")
        month_usd = None
    per_minute = spend.estimate_per_minute(model) if model else None
    return {"provider": provider, "model": model, "month_usd": month_usd, "limit_usd": spend.limit_usd(),
            "limit_tier": settings.load().monthly_limit_usd, "usd_per_minute": per_minute,
            "key_from_cache": secrets.key_from_cache()}


class TestKeyRequest(BaseModel):
    anthropic_key: settings.KeySource | None = None


class AgentStart(BaseModel):
    instruction: str = Field(pattern=r"\S")
    selection: dict | list = {}
    sequence: dict = {}
    # for graphics (all optional; make_graphic refuses without them): app.project.path, the sequence's
    # timebase (ticks per frame) or fps, and its frame size
    projectPath: str = ""
    timebase: str | int | None = None
    fps: float | str | None = None
    width: int | None = None
    height: int | None = None


class ToolResult(BaseModel):
    tool_use_id: str
    content: str
    is_error: bool = False


class AgentResults(BaseModel):
    results: list[ToolResult]


class NewExample(BaseModel):
    raw_words: list[Word]
    final_text: str
    source_clip: str


def create_app(
    token: str,
    stt_device: Callable[[], str],
    transcriber: Callable = lambda: None,
    library_dir: Path | None = None,
    propose: Callable = cuts.propose_cuts,
    extract: Callable = audio.extract_span,
    llm: Callable[[str], str] = llm.ask_text,
    load_error: Callable[[], str | None] = lambda: None,
    stt_phase: Callable[[], str | None] = lambda: None,
    retry_load: Callable[[], None] = lambda: None,
    check_key: Callable[[settings.KeySource], dict] = claude.check_key,
    gcloud_run: Callable = subprocess.run,
    find_gcloud: Callable[[], str | None] = setup.find_gcloud,
    login: setup.Login | None = None,
    agent_runs: agent.Runs | None = None,
    graphics_engine: graphics.Engine | None = None,
    graphics_setup: graphics.Setup | None = None,
) -> FastAPI:
    llm_cost = globals()["llm"].run_cost  # the `llm` parameter shadows the module in here
    app = FastAPI(title="Genius Cut backend", version=config.VERSION)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=LOOPBACK_HOSTS)
    lib_dir = Path(library_dir) if library_dir else config.data_dir() / "library"

    def require_token(authorization: str | None = Header(default=None)) -> None:
        expected = f"Bearer {token}".encode()
        if not authorization or not hmac.compare_digest(authorization.encode(), expected):
            raise HTTPException(status_code=401, detail="Missing or wrong token.")

    auth = [Depends(require_token)]

    def ai_errors(e: Exception) -> HTTPException | None:
        if isinstance(e, secrets.MissingKeyError):
            return HTTPException(status_code=503, detail=str(e))
        if isinstance(e, spend.BudgetExceeded):
            return HTTPException(status_code=402, detail=str(e))
        if isinstance(e, LLMError):
            return HTTPException(status_code=502, detail=str(e))
        return None

    @app.get("/health")
    def health() -> dict:
        body = {"status": "ok", "version": config.VERSION, "api": config.API_VERSION, "pid": os.getpid(),
                "stt_device": stt_device(), "ai": ai_status()}
        if body["stt_device"] == "loading":
            body["stt_phase"] = stt_phase() or "loading"  # "downloading" only when it really is
        err = load_error()
        if err:
            body.update(status="error", error=f"The speech model failed to load: {err}")
        return body

    whisper = threading.Lock()  # one Whisper run at a time, between /trim and transcript jobs
    jobs = transcripts.Jobs(
        transcribe=lambda req, t: trim.transcribe_range(req, transcripts.OneAtATime(t, whisper), extract=extract)[0],
        transcriber=transcriber, load_error=load_error)

    def failed_load() -> HTTPException | None:
        err = load_error()
        if not err:
            return None
        retry_load()
        return HTTPException(status_code=503, detail=(
            f"The speech model failed to load ({err}). Retrying now; try again in a minute."))

    @app.post("/trim", dependencies=auth)
    def post_trim(req: TrimRequest) -> TrimResponse:
        t = transcriber()
        if t is None:
            err = failed_load()
            if err:
                raise err
            raise HTTPException(status_code=503,
                                detail="The speech model is still loading. The first start downloads about 3 GB.")
        try:
            return trim.run_trim(req, transcripts.OneAtATime(t, whisper), lib_dir, propose=propose, extract=extract)
        except (trim.TrimRefused, audio.FfmpegError, ValueError) as e:
            raise HTTPException(status_code=422, detail=str(e)) from e
        except (secrets.MissingKeyError, LLMError) as e:
            raise ai_errors(e) from e

    @app.post("/transcript", dependencies=auth)
    def post_transcript(req: TranscriptRequest) -> TranscriptJob:
        """Cached words (status done), or a job (running, or loading while the model loads)."""
        if transcriber() is None:
            err = failed_load()
            if err:
                raise err
        return jobs.submit(req)

    @app.get("/transcript/{job_id}", dependencies=auth)
    def get_transcript(job_id: str, wait: float = 0.0) -> TranscriptJob:
        """The job's state; with `wait`, long-polls until it finishes (at most 60 s)."""
        job = jobs.get(job_id, wait)
        if job is None:
            raise HTTPException(status_code=404, detail="No such transcript job; ask for the transcript again.")
        return job

    @app.post("/reload", dependencies=auth, status_code=202)
    def post_reload() -> dict:
        retry_load()
        return {"status": "reloading"}

    @app.get("/library", dependencies=auth)
    def get_library() -> dict:
        return {"examples": [e.model_dump() for e in library.list_examples(lib_dir)],
                "summary": library.load_summary(lib_dir)}

    @app.post("/library/examples", dependencies=auth)
    def post_example(body: NewExample) -> StyleExample:
        return library.add_example(body.raw_words, body.final_text, body.source_clip, lib_dir)

    @app.post("/library/summarize", dependencies=auth)
    def post_summarize() -> dict:
        try:
            with spend.meter(kind="summary") as m:
                summary = library.regenerate_summary(lib_dir, llm)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        except (secrets.MissingKeyError, LLMError) as e:
            raise ai_errors(e) from e
        return {"summary": summary, "cost": llm_cost(m).model_dump()}

    @app.get("/settings", dependencies=auth)
    def get_settings() -> settings.Settings:
        return settings.load()

    @app.put("/settings", dependencies=auth)
    def put_settings(body: settings.Settings) -> settings.Settings:
        body.anthropic_key.project = body.anthropic_key.project.strip()
        try:
            settings.validate_for_save(body)
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e)) from e
        old = settings.load()  # only a passing key test completes setup; a new source undoes it
        body.setup_complete = old.setup_complete and old.anthropic_key == body.anthropic_key
        return settings.save(body)

    @app.post("/settings/test-key", dependencies=auth)
    def post_test_key(body: TestKeyRequest | None = None) -> dict:
        src = (body.anthropic_key if body else None) or settings.load().anthropic_key
        try:
            settings.validate_key_source(src)
        except ValueError as e:
            return {"ok": False, "message": str(e)}
        result = check_key(src)
        if result.get("ok"):
            src = src.model_copy(update={"project": src.project.strip()})
            settings.save(settings.load().model_copy(update={"anthropic_key": src, "setup_complete": True}))
        return result

    # ── setup screen (shapes: geniuscut/setup.py) ──────────────────────
    login_job = login or setup.Login(find=find_gcloud)

    def setup_errors(e: Exception) -> HTTPException:
        if isinstance(e, ValueError):
            return HTTPException(status_code=422, detail=str(e))
        return HTTPException(status_code=502, detail=str(e))

    @app.get("/setup/gcloud", dependencies=auth)
    def get_gcloud() -> dict:
        return setup.status(run=gcloud_run, find=find_gcloud)

    @app.post("/setup/login", dependencies=auth, status_code=202)
    def post_login() -> dict:
        try:
            return login_job.start()
        except setup.LoginBusy as e:
            raise HTTPException(status_code=409, detail=str(e)) from e
        except setup.SetupError as e:
            raise setup_errors(e) from e

    @app.get("/setup/login", dependencies=auth)
    def get_login() -> dict:
        return login_job.status()

    @app.get("/setup/projects", dependencies=auth)
    def get_projects() -> dict:
        try:
            return {"projects": setup.list_projects(run=gcloud_run, find=find_gcloud)}
        except (ValueError, setup.SetupError) as e:
            raise setup_errors(e) from e

    @app.get("/setup/secrets", dependencies=auth)
    def get_secrets(project: str = "") -> dict:
        try:
            return {"secrets": setup.list_secrets(project, run=gcloud_run, find=find_gcloud)}
        except (ValueError, setup.SetupError) as e:
            raise setup_errors(e) from e

    @app.get("/setup/versions", dependencies=auth)
    def get_versions(project: str = "", secret: str = "") -> dict:
        try:
            return {"versions": setup.list_versions(project, secret, run=gcloud_run, find=find_gcloud)}
        except (ValueError, setup.SetupError) as e:
            raise setup_errors(e) from e

    @app.get("/usage", dependencies=auth)
    def get_usage() -> dict:
        return spend.usage()

    # ── graphics (shapes: geniuscut/graphics.py) ───────────────────────
    engine = graphics_engine or graphics.Engine()
    graphics_job = graphics_setup or graphics.Setup(engine)

    @app.get("/graphics/status", dependencies=auth)
    def get_graphics_status() -> dict:
        return {**engine.status(), "setup": graphics_job.status()}

    @app.post("/graphics/setup", dependencies=auth, status_code=202)
    def post_graphics_setup() -> dict:
        try:
            return graphics_job.start()
        except graphics.SetupBusy as e:
            raise HTTPException(status_code=409, detail=str(e)) from e

    # ── agent runs (shapes: geniuscut/agent.py) ────────────────────────
    runs = agent_runs or agent.Runs(engine=engine)

    def agent_call(fn, *args) -> dict:
        try:
            return fn(*args)
        except agent.RunError as e:
            raise HTTPException(status_code=e.status, detail=str(e)) from e

    @app.post("/agent/runs", dependencies=auth)
    def post_agent_run(body: AgentStart) -> dict:
        context = {k: getattr(body, k) for k in ("projectPath", "timebase", "fps", "width", "height")}
        return agent_call(runs.start, body.instruction, body.selection, body.sequence, context)

    @app.post("/agent/runs/{run_id}/results", dependencies=auth)
    def post_agent_results(run_id: str, body: AgentResults) -> dict:
        return agent_call(runs.results, run_id, [r.model_dump() for r in body.results])

    @app.post("/agent/runs/{run_id}/approve", dependencies=auth)
    def post_agent_approve(run_id: str) -> dict:
        return agent_call(runs.approve, run_id)

    @app.delete("/agent/runs/{run_id}", dependencies=auth)
    def delete_agent_run(run_id: str) -> dict:
        runs.cancel(run_id)
        return {"ok": True}

    return app


def load_phase() -> str:
    """'downloading' if the speech model this machine will use isn't cached yet, else 'loading'."""
    from geniuscut import stt

    name = stt.model_for("cuda" if stt.cuda_runtime_available() else "cpu")
    return "loading" if stt.model_is_cached(name) else "downloading"


class _ModelLoader:
    """Loads the transcriber once, in the background; a failed load can be retried."""

    def __init__(self):
        self.transcriber = None
        self.error: str | None = None
        self.phase: str | None = None
        self._lock = threading.Lock()
        self._loading = False
        self.retry()

    def retry(self) -> None:
        with self._lock:
            if self._loading or self.transcriber is not None:
                return
            self._loading = True
        threading.Thread(target=self._load, daemon=True).start()

    def _load(self):
        try:
            try:
                self.phase = load_phase()
            except Exception:  # noqa: BLE001 — the phase is only for the panel's message
                self.phase = "loading"
            from geniuscut.stt import FasterWhisperTranscriber

            t = FasterWhisperTranscriber()
            self.transcriber, self.error = t, None
            log.info("Speech model ready on %s", t.device)
        except Exception as e:  # noqa: BLE001 — surfaced through /health and /trim
            self.error = str(e)
            log.exception("Speech model failed to load")
        finally:
            with self._lock:
                self._loading = False

    def device(self) -> str:
        if self.transcriber:
            return self.transcriber.device
        return "failed" if self.error else "loading"


if __name__ == "__main__":
    import uvicorn

    logging.basicConfig(level=logging.INFO)
    if "--selftest" in _sys.argv:
        from geniuscut.stt import FasterWhisperTranscriber
        t = FasterWhisperTranscriber()
        words = t.transcribe(Path(_here) / "tests" / "fixtures" / "speech.wav")
        print(f"selftest ok: {t.device} {t.model_name} {len(words)} words")
        _sys.exit(0 if len(words) >= 5 else 1)
    loader = _ModelLoader()
    uvicorn.run(
        create_app(token=config.get_or_create_token(), stt_device=loader.device, stt_phase=lambda: loader.phase,
                   transcriber=lambda: loader.transcriber,
                   load_error=lambda: None if loader.transcriber else loader.error,
                   retry_load=loader.retry),
        host=config.HOST,
        port=config.PORT,
    )
