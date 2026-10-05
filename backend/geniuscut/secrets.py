"""API keys, kept out of the repo and off disk.

Mirrors the agent-georg umbrella's `lib/gcp_secrets.py` pattern, which this standalone
repo cannot import: an env var if set, else GCP Secret Manager (project `agent-georg`)
through the gcloud CLI.
- Anthropic: `ANTHROPIC_API_KEY`, else secret `ANTHROPIC_API_KEY`.
- Gemini: `GENIUSCUT_GEMINI_API_KEY`, else secret `GOOGLE_API_KEY` (key "gemini-hook-app").
"""

import os
import shutil
import subprocess
from typing import Callable

GSM_PROJECT = "agent-georg"
GSM_SECRET = "ANTHROPIC_API_KEY"
GEMINI_ENV = "GENIUSCUT_GEMINI_API_KEY"
GEMINI_GSM_SECRET = "GOOGLE_API_KEY"


class MissingKeyError(RuntimeError):
    pass


def _key(env: str, secret: str, label: str, run: Callable, gcloud: str | None) -> str:
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
            return result.stdout.strip()
        detail = (result.stderr or "no output").strip()
    raise MissingKeyError(
        f"No {label} API key. Set the {env} environment variable, or sign in with "
        f"`gcloud auth login` as an account that can read secret {secret} in project "
        f"{GSM_PROJECT}. ({detail})"
    )


def anthropic_api_key(run: Callable = subprocess.run, gcloud: str | None = None) -> str:
    return _key("ANTHROPIC_API_KEY", GSM_SECRET, "Anthropic", run, gcloud)


def gemini_api_key(run: Callable = subprocess.run, gcloud: str | None = None) -> str:
    return _key(GEMINI_ENV, GEMINI_GSM_SECRET, "Gemini", run, gcloud)
