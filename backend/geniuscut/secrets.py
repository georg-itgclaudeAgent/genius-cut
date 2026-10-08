"""API keys, kept out of the repo and off disk.

Mirrors the agent-georg umbrella's `lib/gcp_secrets.py` pattern, which this standalone
repo cannot import: an env var if set, else GCP Secret Manager (project `agent-georg`)
through the gcloud CLI.
- Anthropic: `ANTHROPIC_API_KEY`, else secret `ANTHROPIC_API_KEY`.
- Gemini: `GENIUSCUT_GEMINI_API_KEY`, else secret `GOOGLE_API_KEY` (key "gemini-hook-app").

The Gemini key read from Secret Manager is also cached on this PC, encrypted for the Windows
user with DPAPI (`<data dir>/gemini_key.dpapi`), and used when gcloud can't sign in: the laptop's
gcloud login expires every day or two (Checkpoint B, 2026-10-08). Secret Manager stays the
source of truth: whenever it answers, its value replaces the cache.
"""

import ctypes
import os
import shutil
import subprocess
from typing import Callable

from geniuscut import config

GSM_PROJECT = "agent-georg"
GSM_SECRET = "ANTHROPIC_API_KEY"
GEMINI_ENV = "GENIUSCUT_GEMINI_API_KEY"
GEMINI_GSM_SECRET = "GOOGLE_API_KEY"


class MissingKeyError(RuntimeError):
    pass


class _Blob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_uint32), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _dpapi(data: bytes, protect: bool) -> bytes:
    """Windows DPAPI for the current user: only this Windows account on this PC can decrypt."""
    crypt32, kernel32 = ctypes.windll.crypt32, ctypes.windll.kernel32
    buf = ctypes.create_string_buffer(data, len(data))
    blob_in, blob_out = _Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char))), _Blob()
    fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    if not fn(ctypes.byref(blob_in), None, None, None, None, 0x1, ctypes.byref(blob_out)):  # UI_FORBIDDEN
        raise OSError("DPAPI failed")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        kernel32.LocalFree(blob_out.pbData)


def protect(data: bytes) -> bytes:
    return _dpapi(data, True)


def unprotect(data: bytes) -> bytes:
    return _dpapi(data, False)


def _cache_path(name: str):
    return config.data_dir() / f"{name}.dpapi"


def _save_cached(name: str, key: str) -> None:
    try:
        path = _cache_path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(protect(key.encode("utf-8")))
    except Exception:  # noqa: BLE001 — the cache is a convenience; Secret Manager still works
        pass


def _load_cached(name: str) -> str | None:
    try:
        return unprotect(_cache_path(name).read_bytes()).decode("utf-8").strip() or None
    except Exception:  # noqa: BLE001 — missing, corrupt or another user's: not usable
        return None


def _key(env: str, secret: str, label: str, run: Callable, gcloud: str | None, cache: str | None = None) -> str:
    key = os.environ.get(env, "").strip()
    if key:
        return key
    gcloud = gcloud or shutil.which("gcloud") or shutil.which("gcloud.cmd")
    detail = "gcloud is not installed"
    if gcloud:
        result = run(
            [gcloud, "secrets", "versions", "access", "latest",
             f"--secret={secret}", f"--project={GSM_PROJECT}"],
            capture_output=True, text=True,
        )
        if result.returncode == 0 and result.stdout.strip():
            key = result.stdout.strip()
            if cache:
                _save_cached(cache, key)
            return key
        detail = (result.stderr or "no output").strip()
    cached = _load_cached(cache) if cache else None
    if cached:
        return cached
    raise MissingKeyError(
        f"No {label} API key. Set the {env} environment variable, or sign in with "
        f"`gcloud auth login` as an account that can read secret {secret} in project "
        f"{GSM_PROJECT}. ({detail})"
    )


def anthropic_api_key(run: Callable = subprocess.run, gcloud: str | None = None) -> str:
    return _key("ANTHROPIC_API_KEY", GSM_SECRET, "Anthropic", run, gcloud)


def gemini_api_key(run: Callable = subprocess.run, gcloud: str | None = None) -> str:
    return _key(GEMINI_ENV, GEMINI_GSM_SECRET, "Gemini", run, gcloud, cache="gemini_key")
