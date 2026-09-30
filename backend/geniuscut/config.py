"""Where Genius Cut keeps its local state, and the loopback auth token."""

import os
import secrets
from pathlib import Path

VERSION = "0.1.0"
HOST = "127.0.0.1"
PORT = 8791


def data_dir() -> Path:
    """`%APPDATA%/itGenius/genius-cut`, or `GENIUSCUT_DATA_DIR` when set (tests, dev)."""
    override = os.environ.get("GENIUSCUT_DATA_DIR")
    if override:
        return Path(override)
    return Path(os.environ["APPDATA"]) / "itGenius" / "genius-cut"


def get_or_create_token(directory: Path | None = None) -> str:
    """The shared secret the panel sends as `Authorization: Bearer`.

    Created once on first run; stops any other page on localhost from calling the API.
    """
    directory = directory or data_dir()
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "token"
    if path.exists():
        existing = path.read_text(encoding="utf-8").strip()
        if existing:
            return existing
    token = secrets.token_urlsafe(32)
    path.write_text(token, encoding="utf-8")
    return token
