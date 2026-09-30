"""Genius Cut local backend — FastAPI on 127.0.0.1:8791.

Run: `.venv/Scripts/python server.py`. Every route except `/health` needs
`Authorization: Bearer <token>`, where the token lives in `<data dir>/token`.
The Whisper model loads in the background, so `/health` answers straight away
(`stt_device: "loading"`) and `/trim` returns 503 until it's ready.
"""

import hmac
import logging
import threading
from pathlib import Path
from typing import Callable

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel

from geniuscut import audio, claude, config, cuts, library, secrets, trim
from geniuscut.models import StyleExample, TrimRequest, TrimResponse, Word

log = logging.getLogger("geniuscut")


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
    llm: Callable[[str], str] = claude.ask_text,
) -> FastAPI:
    app = FastAPI(title="Genius Cut backend", version=config.VERSION)
    lib_dir = Path(library_dir) if library_dir else config.data_dir() / "library"

    def require_token(authorization: str | None = Header(default=None)) -> None:
        expected = f"Bearer {token}"
        if not authorization or not hmac.compare_digest(authorization, expected):
            raise HTTPException(status_code=401, detail="Missing or wrong token.")

    auth = [Depends(require_token)]

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "version": config.VERSION, "stt_device": stt_device()}

    @app.post("/trim", dependencies=auth)
    def post_trim(req: TrimRequest) -> TrimResponse:
        t = transcriber()
        if t is None:
            raise HTTPException(status_code=503,
                                detail="The speech model is still loading. The first start downloads about 3 GB.")
        try:
            return trim.run_trim(req, t, lib_dir, propose=propose, extract=extract)
        except audio.FfmpegError as e:
            raise HTTPException(status_code=422, detail=str(e)) from e
        except secrets.MissingKeyError as e:
            raise HTTPException(status_code=503, detail=str(e)) from e
        except claude.ClaudeError as e:
            raise HTTPException(status_code=502, detail=str(e)) from e

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
            return {"summary": library.regenerate_summary(lib_dir, llm)}
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        except secrets.MissingKeyError as e:
            raise HTTPException(status_code=503, detail=str(e)) from e
        except claude.ClaudeError as e:
            raise HTTPException(status_code=502, detail=str(e)) from e

    return app


class _ModelLoader:
    """Loads the transcriber once, in the background, and remembers any failure."""

    def __init__(self):
        self.transcriber = None
        self.error: str | None = None
        threading.Thread(target=self._load, daemon=True).start()

    def _load(self):
        try:
            from geniuscut.stt import FasterWhisperTranscriber

            self.transcriber = FasterWhisperTranscriber()
            log.info("Speech model ready on %s", self.transcriber.device)
        except Exception as e:  # noqa: BLE001 — surfaced through /health
            self.error = str(e)
            log.exception("Speech model failed to load")

    def device(self) -> str:
        if self.transcriber:
            return self.transcriber.device
        return f"failed: {self.error}" if self.error else "loading"


if __name__ == "__main__":
    import uvicorn

    logging.basicConfig(level=logging.INFO)
    loader = _ModelLoader()
    uvicorn.run(
        create_app(token=config.get_or_create_token(), stt_device=loader.device,
                   transcriber=lambda: loader.transcriber),
        host=config.HOST,
        port=config.PORT,
    )
