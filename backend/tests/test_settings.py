"""The per-editor settings file and the Anthropic key it points at (each editor's own GCP project)."""

import json
import subprocess
import sys

import pytest

from geniuscut import config, secrets, settings

KEY_SOURCE = {"project": "my-gcp-project", "secret": "ANTHROPIC_API_KEY", "version": "latest"}


def _ok(key, calls=None):
    def run(cmd, **kw):
        if calls is not None:
            calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout=key + "\n", stderr="")
    return run


def _expired(cmd, **kw):
    return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="Reauthentication failed. cannot prompt")


@pytest.fixture(autouse=True)
def _no_env_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)


# ── settings file ──────────────────────────────────────────────────

def test_settings_live_in_the_data_dir():
    assert settings.path() == config.data_dir() / "settings.json"


def test_missing_file_means_defaults():
    s = settings.load()
    assert s.anthropic_key.project == ""
    assert (s.anthropic_key.secret, s.anthropic_key.version) == ("ANTHROPIC_API_KEY", "latest")
    assert s.monthly_limit_usd == 20


def test_save_then_load_round_trips():
    settings.save(settings.Settings(anthropic_key=KEY_SOURCE, monthly_limit_usd=100))
    s = settings.load()
    assert s.anthropic_key.project == "my-gcp-project" and s.monthly_limit_usd == 100
    assert json.loads(settings.path().read_text(encoding="utf-8"))["monthly_limit_usd"] == 100


@pytest.mark.parametrize("raw", [b"{not json", b"\xff\xfe", b"[1, 2]", b'"text"', b""])
def test_a_corrupt_file_means_defaults(raw):
    settings.path().parent.mkdir(parents=True, exist_ok=True)
    settings.path().write_bytes(raw)
    assert settings.load() == settings.Settings()


def test_one_bad_field_keeps_the_good_ones():
    settings.path().parent.mkdir(parents=True, exist_ok=True)
    settings.path().write_text(json.dumps({"anthropic_key": {"project": "p-1"}, "monthly_limit_usd": 50}),
                               encoding="utf-8")
    s = settings.load()
    assert s.anthropic_key.project == "p-1" and s.anthropic_key.secret == "ANTHROPIC_API_KEY"
    assert s.monthly_limit_usd == 20


@pytest.mark.parametrize("limit", [0, 2, 50, 101, -20])
def test_only_20_or_100_is_a_valid_limit(limit):
    with pytest.raises(ValueError):
        settings.Settings(anthropic_key=KEY_SOURCE, monthly_limit_usd=limit)


@pytest.mark.parametrize("field, value", [
    ("project", ""), ("project", "   "), ("project", "--impersonate-service-account=x"),
    ("secret", ""), ("secret", "a b"), ("version", "--flag"), ("version", ""),
])
def test_key_source_fields_are_validated(field, value):
    with pytest.raises(ValueError):
        settings.validate_for_save(settings.Settings(anthropic_key={**KEY_SOURCE, field: value}))


def test_a_valid_settings_object_passes_validation():
    settings.validate_for_save(settings.Settings(anthropic_key=KEY_SOURCE, monthly_limit_usd=100))


# ── Anthropic key from the editor's own project ────────────────────

def test_env_key_wins_over_settings(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-env")
    settings.save(settings.Settings(anthropic_key=KEY_SOURCE))
    assert secrets.anthropic_api_key(run=lambda *a, **k: pytest.fail("gcloud must not run")) == "sk-env"


def test_key_is_read_from_the_configured_project_secret_and_version():
    settings.save(settings.Settings(anthropic_key={"project": "editor-proj", "secret": "MY_KEY", "version": "3"}))
    calls = []
    assert secrets.anthropic_api_key(run=_ok("sk-gsm", calls), gcloud="gcloud") == "sk-gsm"
    assert calls[0] == ["gcloud", "secrets", "versions", "access", "3", "--secret=MY_KEY", "--project=editor-proj"]


def test_an_explicit_source_overrides_the_saved_settings():
    calls = []
    src = settings.KeySource(project="other-proj")
    assert secrets.anthropic_api_key(run=_ok("sk-x", calls), gcloud="gcloud", source=src) == "sk-x"
    assert "--project=other-proj" in calls[0]


def test_no_project_configured_says_to_finish_setup():
    with pytest.raises(secrets.MissingKeyError) as e:
        secrets.anthropic_api_key(run=lambda *a, **k: pytest.fail("gcloud must not run"), gcloud="gcloud")
    assert "Genius Cut setup" in str(e.value)


def test_gcloud_failure_names_the_project_and_how_to_fix_it():
    settings.save(settings.Settings(anthropic_key=KEY_SOURCE))
    with pytest.raises(secrets.MissingKeyError) as e:
        secrets.anthropic_api_key(run=_expired, gcloud="gcloud")
    assert "my-gcp-project" in str(e.value) and "gcloud auth login" in str(e.value)


windows = pytest.mark.skipif(sys.platform != "win32", reason="DPAPI is Windows-only")


@windows
def test_the_anthropic_key_is_cached_encrypted_and_used_when_gcloud_fails():
    settings.save(settings.Settings(anthropic_key=KEY_SOURCE))
    assert secrets.anthropic_api_key(run=_ok("sk-ant-gsm"), gcloud="gcloud") == "sk-ant-gsm"
    cached = config.data_dir() / "anthropic_key.dpapi"
    assert cached.exists() and b"sk-ant-gsm" not in cached.read_bytes()
    assert secrets.anthropic_api_key(run=_expired, gcloud="gcloud") == "sk-ant-gsm"


@windows
@pytest.mark.parametrize("field, value", [("project", "another-proj"), ("secret", "OTHER"), ("version", "7")])
def test_a_changed_key_source_never_reuses_the_cached_key(field, value):
    settings.save(settings.Settings(anthropic_key=KEY_SOURCE))
    secrets.anthropic_api_key(run=_ok("sk-ant-old"), gcloud="gcloud")
    settings.save(settings.Settings(anthropic_key={**KEY_SOURCE, field: value}))
    with pytest.raises(secrets.MissingKeyError):
        secrets.anthropic_api_key(run=_expired, gcloud="gcloud")


@windows
def test_no_project_ignores_any_cached_key():
    settings.save(settings.Settings(anthropic_key=KEY_SOURCE))
    secrets.anthropic_api_key(run=_ok("sk-ant-old"), gcloud="gcloud")
    settings.save(settings.Settings())
    with pytest.raises(secrets.MissingKeyError, match="Genius Cut setup"):
        secrets.anthropic_api_key(run=_expired, gcloud="gcloud")


def test_fresh_only_skips_env_and_cache(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-env")
    calls = []
    src = settings.KeySource(project="proj-1")
    assert secrets.anthropic_api_key(run=_ok("sk-gsm", calls), gcloud="gcloud", source=src, fresh_only=True) == "sk-gsm"
    assert calls
    with pytest.raises(secrets.MissingKeyError):
        secrets.anthropic_api_key(run=_expired, gcloud="gcloud", source=src, fresh_only=True)


def test_the_key_never_appears_in_the_error():
    settings.save(settings.Settings(anthropic_key=KEY_SOURCE))

    def leaky(cmd, **kw):
        return subprocess.CompletedProcess(cmd, 1, stdout="sk-ant-leak", stderr="denied")

    with pytest.raises(secrets.MissingKeyError) as e:
        secrets.anthropic_api_key(run=leaky, gcloud="gcloud")
    assert "sk-ant-leak" not in str(e.value)
