"""The Anthropic API key, kept out of the repo and off disk.

Mirrors the agent-georg umbrella's `lib/gcp_secrets.py` pattern, which this standalone
repo cannot import: the `ANTHROPIC_API_KEY` env var if set, else GCP Secret Manager
(project `agent-georg`) through the gcloud CLI.
"""

import os
import shutil
import subprocess
from typing import Callable

GSM_PROJECT = "agent-georg"
GSM_SECRET = "ANTHROPIC_API_KEY"


class MissingKeyError(RuntimeError):
    pass


def anthropic_api_key(run: Callable = subprocess.run, gcloud: str | None = None) -> str:
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if key:
        return key
    gcloud = gcloud or shutil.which("gcloud") or shutil.which("gcloud.cmd")
    detail = "gcloud is not installed"
    if gcloud:
        result = run(
            [gcloud, "secrets", "versions", "access", "latest",
             f"--secret={GSM_SECRET}", f"--project={GSM_PROJECT}"],
            capture_output=True, text=True,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
        detail = (result.stderr or "no output").strip()
    raise MissingKeyError(
        "No Anthropic API key. Set the ANTHROPIC_API_KEY environment variable, or sign in with "
        f"`gcloud auth login` as an account that can read secret {GSM_SECRET} in project "
        f"{GSM_PROJECT}. ({detail})"
    )
