"""Genius Cut local backend — FastAPI on 127.0.0.1:8791.

Run: `.venv/Scripts/python server.py`. Every route except `/health` needs
`Authorization: Bearer <token>`, where the token lives in `<data dir>/token`.
"""

import hmac
from typing import Callable

from fastapi import Depends, FastAPI, Header, HTTPException

from geniuscut import config


def create_app(token: str, stt_device: Callable[[], str]) -> FastAPI:
    app = FastAPI(title="Genius Cut backend", version=config.VERSION)

    def require_token(authorization: str | None = Header(default=None)) -> None:
        expected = f"Bearer {token}"
        if not authorization or not hmac.compare_digest(authorization, expected):
            raise HTTPException(status_code=401, detail="Missing or wrong token.")

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "version": config.VERSION, "stt_device": stt_device()}

    @app.get("/library", dependencies=[Depends(require_token)])
    def library() -> dict:
        return {"examples": [], "summary": None}

    return app


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        create_app(token=config.get_or_create_token(), stt_device=lambda: "not loaded"),
        host=config.HOST,
        port=config.PORT,
    )
