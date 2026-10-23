"""This editor's Genius Cut settings: `<data dir>/settings.json`. Never holds a secret.

- `anthropic_key`: where the Anthropic API key lives, in the editor's OWN Google Cloud
  project's Secret Manager (`project`, `secret`, `version`). Read by `secrets.py`.
- `monthly_limit_usd`: 20 (default) or 100, the spend gate's limit (`spend.py`).
- `setup_complete`: the Setup screen is done; only a passing key test sets it.
- `model`: the catalog id the picker selected (catalog.py), default `anthropic:claude-opus-5-5`. A stored
  id that isn't in the catalog (an older build's, a hand edit) loads as the default.
- `vertex`: `{project, region}` for Claude on Google Cloud Vertex AI (default agent-georg, global).

Loading never fails: a missing or corrupt file means defaults, and a single bad field
falls back to its default without losing the others.
"""

import json
import re
from typing import Literal

from pydantic import BaseModel, ValidationError, field_validator

from geniuscut import catalog, config

LIMITS = (20, 100)
DEFAULT_LIMIT = 20

# gcloud gets these as argv elements, and `gcloud.cmd` passes them through cmd.exe: the spec's
# patterns (2026-10-14), plus no leading "-" on a secret, so nothing can look like a flag.
_PROJECT = re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$")
_SECRET = re.compile(r"^(?!-)[A-Za-z0-9_-]{1,255}$")
_VERSION = re.compile(r"^(latest|[0-9]+)$")
# Vertex locations: `global`, a multi-region (`us`, `eu`) or a region such as `us-east5`, `europe-west1`.
_REGION = re.compile(r"^(global|[a-z]{2,10}|[a-z]{2,12}-[a-z]{2,12}[0-9]{1,2})$")
VERTEX_PROJECT = "agent-georg"
VERTEX_REGION = "global"


class KeySource(BaseModel):
    project: str = ""
    secret: str = "ANTHROPIC_API_KEY"
    version: str = "latest"


class VertexSettings(BaseModel):
    project: str = VERTEX_PROJECT
    region: str = VERTEX_REGION

    @field_validator("project")
    @classmethod
    def _project(cls, v: str) -> str:
        v = v.strip() if isinstance(v, str) else v
        if not isinstance(v, str) or not _PROJECT.fullmatch(v):
            raise ValueError("Enter the Google Cloud project ID for Vertex AI.")
        return v

    @field_validator("region")
    @classmethod
    def _region(cls, v: str) -> str:
        v = v.strip() if isinstance(v, str) else v
        if not isinstance(v, str) or not _REGION.fullmatch(v):
            raise ValueError("Enter a Vertex AI region such as global or us-east5.")
        return v


class Settings(BaseModel):
    anthropic_key: KeySource = KeySource()
    monthly_limit_usd: Literal[20, 100] = DEFAULT_LIMIT
    setup_complete: bool = False  # set only by a passing POST /settings/test-key
    model: str = catalog.DEFAULT_MODEL
    vertex: VertexSettings = VertexSettings()

    @field_validator("model")
    @classmethod
    def _model(cls, v: str) -> str:
        validate_model(v)
        return v


def validate_model(model_id) -> None:
    if not catalog.is_known(model_id):
        raise ValueError(f"Unknown AI model {model_id!r}: pick one from the list.")


def validate_project(project: str) -> None:
    if not isinstance(project, str) or not _PROJECT.fullmatch(project):
        raise ValueError("Enter the Google Cloud project ID that holds your Anthropic key.")


def validate_secret(secret: str) -> None:
    if not isinstance(secret, str) or not _SECRET.fullmatch(secret):
        raise ValueError("The secret name may only contain letters, digits, '_' and '-'.")


def validate_version(version: str) -> None:
    if not isinstance(version, str) or not _VERSION.fullmatch(version):
        raise ValueError("The secret version must be 'latest' or a version number.")


def validate_key_source(src: KeySource) -> None:
    """Raise ValueError unless `src` names a project, secret and version gcloud can safely take."""
    validate_project(src.project.strip())
    validate_secret(src.secret)
    validate_version(src.version)


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
