"""Genius Cut local backend — FastAPI on 127.0.0.1:8791.

Run: `.venv/Scripts/python server.py`. Every route except `/health` needs
`Authorization: Bearer <token>`, where the token lives in `<data dir>/token`.
The Whisper model loads in the background, so `/health` answers straight away
(`stt_device: "loading"`) and `/trim` returns 503 until it's ready. A failed load
is reported as `status: "error"` and retried on the next `/trim`.

The panel calls this through Node's `http` module (CEP `--enable-nodejs`), so no
CORS is configured: a browser page can't reach the API, and the Host check below
also stops DNS-rebinding tricks.

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
import logging
import threading
from pathlib import Path
from typing import Callable

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel

from geniuscut import audio, config, cuts, library, llm, secrets, spend, trim
from geniuscut.llm import LLMError
from geniuscut.models import StyleExample, TrimRequest, TrimResponse, Word

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
            "usd_per_minute": per_minute}


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
    retry_load: Callable[[], None] = lambda: None,
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
        body = {"status": "ok", "version": config.VERSION, "stt_device": stt_device(), "ai": ai_status()}
        err = load_error()
        if err:
            body.update(status="error", error=f"The speech model failed to load: {err}")
        return body

    @app.post("/trim", dependencies=auth)
    def post_trim(req: TrimRequest) -> TrimResponse:
        t = transcriber()
        if t is None:
            err = load_error()
            if err:
                retry_load()
                raise HTTPException(status_code=503, detail=(
                    f"The speech model failed to load ({err}). Retrying now; try again in a minute."))
            raise HTTPException(status_code=503,
                                detail="The speech model is still loading. The first start downloads about 3 GB.")
        try:
            return trim.run_trim(req, t, lib_dir, propose=propose, extract=extract)
        except (trim.TrimRefused, audio.FfmpegError, ValueError) as e:
            raise HTTPException(status_code=422, detail=str(e)) from e
        except (secrets.MissingKeyError, LLMError) as e:
            raise ai_errors(e) from e

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

    return app


class _ModelLoader:
    """Loads the transcriber once, in the background; a failed load can be retried."""

    def __init__(self):
        self.transcriber = None
        self.error: str | None = None
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
        create_app(token=config.get_or_create_token(), stt_device=loader.device,
                   transcriber=lambda: loader.transcriber,
                   load_error=lambda: None if loader.transcriber else loader.error,
                   retry_load=loader.retry),
        host=config.HOST,
        port=config.PORT,
    )
