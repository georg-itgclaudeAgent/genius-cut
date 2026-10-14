"""This editor's Genius Cut settings: `<data dir>/settings.json`. Never holds a secret.

- `anthropic_key`: where the Anthropic API key lives, in the editor's OWN Google Cloud
  project's Secret Manager (`project`, `secret`, `version`). Read by `secrets.py`.
- `monthly_limit_usd`: 20 (default) or 100, the spend gate's limit (`spend.py`).

Loading never fails: a missing or corrupt file means defaults, and a single bad field
falls back to its default without losing the others.
"""

import json
import re
from typing import Literal

from pydantic import BaseModel, ValidationError

from geniuscut import config

LIMITS = (20, 100)
DEFAULT_LIMIT = 20

# gcloud gets these as argv elements; they must not be able to look like a flag.
_PROJECT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.:_-]*$")  # incl. domain-scoped "example.com:proj"
_NAME = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_-]*$")       # secret IDs and version numbers/aliases


class KeySource(BaseModel):
    project: str = ""
    secret: str = "ANTHROPIC_API_KEY"
    version: str = "latest"


class Settings(BaseModel):
    anthropic_key: KeySource = KeySource()
    monthly_limit_usd: Literal[20, 100] = DEFAULT_LIMIT


def validate_key_source(src: KeySource) -> None:
    """Raise ValueError unless `src` names a project, secret and version gcloud can safely take."""
    if not _PROJECT.match(src.project.strip()):
        raise ValueError("Enter the Google Cloud project ID that holds your Anthropic key.")
    if not _NAME.match(src.secret):
        raise ValueError("The secret name may only contain letters, digits, '_' and '-'.")
    if not _NAME.match(src.version):
        raise ValueError("The secret version must be 'latest' or a version number.")


def validate_for_save(s: Settings) -> None:
    validate_key_source(s.anthropic_key)


def path():
    return config.data_dir() / "settings.json"


def load() -> Settings:
    try:
        raw = json.loads(path().read_bytes().decode("utf-8"))
    except (OSError, ValueError):  # missing, unreadable, bad bytes or bad JSON
        return Settings()
    if not isinstance(raw, dict):
        return Settings()
    fields = {}
    for name in Settings.model_fields:
        if name in raw:
            try:
                Settings.model_validate({name: raw[name]})
            except ValidationError:
                continue
            fields[name] = raw[name]
    return Settings.model_validate(fields)


def save(s: Settings) -> Settings:
    """Write the settings (atomically: a crash mid-write leaves the old file)."""
    p = path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(s.model_dump_json(indent=2), encoding="utf-8")
    tmp.replace(p)
    return s
