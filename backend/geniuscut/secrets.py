"""API keys, kept out of the repo and off disk.

Mirrors the agent-georg umbrella's `lib/gcp_secrets.py` pattern, which this standalone
repo cannot import: an env var if set, else GCP Secret Manager through the gcloud CLI.
- Anthropic: `ANTHROPIC_API_KEY`, else the secret named in this editor's settings
  (`settings.json` `anthropic_key`: their OWN Google Cloud project, secret and version).
  No project configured means setup isn't finished.
- Gemini: `GENIUSCUT_GEMINI_API_KEY`, else secret `GOOGLE_API_KEY` in project `agent-georg`
  (key "gemini-hook-app").

A key read from Secret Manager is also cached on this PC, encrypted for the Windows user with
DPAPI (`<data dir>/gemini_key.dpapi`, `anthropic_key.dpapi`), and used when gcloud can't sign
in: the laptop's gcloud login expires every day or two (Checkpoint B, 2026-10-08). The
Anthropic cache is tied to the project/secret/version it came from, so changing the setting
never reuses an old key. Secret Manager stays the source of truth: whenever it answers, its
value replaces the cache.
"""

import ctypes
import os
import subprocess
from typing import Callable

from geniuscut import config, settings, setup

# Whether the Anthropic key last handed out was the cached copy (Secret Manager didn't answer,
# usually an expired gcloud login): /health shows it so Settings can say so.
_from_cache = False


def key_from_cache() -> bool:
    return _from_cache

GSM_PROJECT = "agent-georg"
ANTHROPIC_ENV = "ANTHROPIC_API_KEY"
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


def _save_cached(name: str, key: str, tag: str = "") -> None:
    """`tag` names where the key came from; a later load with another tag ignores it."""
    try:
        path = _cache_path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(protect((f"{tag}\0{key}" if tag else key).encode("utf-8")))
    except Exception:  # noqa: BLE001 — the cache is a convenience; Secret Manager still works
        pass


def _load_cached(name: str, tag: str = "") -> str | None:
    try:
        text = unprotect(_cache_path(name).read_bytes()).decode("utf-8")
    except Exception:  # noqa: BLE001 — missing, corrupt or another user's: not usable
        return None
    if tag:
        stored, sep, text = text.partition("\0")
        if not sep or stored != tag:
            return None
    return text.strip() or None


def _gsm(secret: str, project: str, version: str, run: Callable, gcloud: str | None) -> tuple[str | None, str]:
    """(key, None-or-why-not) from Secret Manager; the key never goes into the reason."""
    gcloud = gcloud or setup.find_gcloud()  # PATH or the standard install paths (fresh installs)
    if not gcloud:
        return None, "gcloud is not installed"
    try:
        result = run(
            [gcloud, "secrets", "versions", "access", version, f"--secret={secret}", f"--project={project}"],
            capture_output=True, text=True, timeout=setup.GCLOUD_TIMEOUT_S, **setup.quiet(),
        )
    except subprocess.TimeoutExpired:
        return None, f"gcloud didn't answer within {setup.GCLOUD_TIMEOUT_S} s"
    except OSError as e:
        return None, f"gcloud couldn't start: {e}"
    if result.returncode == 0 and result.stdout.strip():
        return result.stdout.strip(), ""
    return None, (result.stderr or "no output").strip()


def _key(env: str, secret: str, label: str, run: Callable, gcloud: str | None, cache: str | None = None) -> str:
    key = os.environ.get(env, "").strip()
    if key:
        return key
    key, detail = _gsm(secret, GSM_PROJECT, "latest", run, gcloud)
    if key:
        if cache:
            _save_cached(cache, key)
        return key
    cached = _load_cached(cache) if cache else None
    if cached:
        return cached
    raise MissingKeyError(
        f"No {label} API key. Set the {env} environment variable, or sign in with "
        f"`gcloud auth login` as an account that can read secret {secret} in project "
        f"{GSM_PROJECT}. ({detail})"
    )


def anthropic_api_key(run: Callable = subprocess.run, gcloud: str | None = None,
                      source: "settings.KeySource | None" = None, *, fresh_only: bool = False) -> str:
    """The Anthropic key: env, else the editor's own Secret Manager (from settings, or `source`),
    else the cached copy of that same secret. `fresh_only` skips env and cache (the setup test)."""
    global _from_cache
    if not fresh_only:
        key = os.environ.get(ANTHROPIC_ENV, "").strip()
        if key:
            _from_cache = False
            return key
    src = source or settings.load().anthropic_key
    project = src.project.strip()
    if not project:
        raise MissingKeyError(
            "No Anthropic API key is set up. Finish Genius Cut setup: enter the Google Cloud project "
            "whose Secret Manager holds your Anthropic API key."
        )
    try:  # a hand-edited settings.json must not reach cmd.exe
        settings.validate_key_source(src)
    except ValueError as e:
        raise MissingKeyError(f"{e} Check it in Genius Cut setup.") from e
    tag = f"{project}/{src.secret}/{src.version}"
    key, detail = _gsm(src.secret, project, src.version, run, gcloud)
    if key:
        _save_cached("anthropic_key", key, tag)
        if not fresh_only:
            _from_cache = False
        return key
    cached = None if fresh_only else _load_cached("anthropic_key", tag)
    if cached:
        _from_cache = True
        return cached
    raise MissingKeyError(
        f"Couldn't read the Anthropic API key (secret {src.secret}, version {src.version}) from "
        f"project {project}. Sign in with `gcloud auth login` as an account that can read it, "
        f"or check the project in Genius Cut setup. ({detail})"
    )


def gemini_api_key(run: Callable = subprocess.run, gcloud: str | None = None) -> str:
    return _key(GEMINI_ENV, GEMINI_GSM_SECRET, "Gemini", run, gcloud, cache="gemini_key")
