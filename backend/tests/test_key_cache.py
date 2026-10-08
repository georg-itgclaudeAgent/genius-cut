"""The Gemini key is cached on this PC, encrypted for the Windows user (DPAPI), so an expired
gcloud login doesn't stop Genius Cut (Checkpoint B, 2026-10-08). Secret Manager stays the source."""

import subprocess
import sys

import pytest

from geniuscut import config, secrets

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="DPAPI is Windows-only")


def _ok(key):
    return lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, stdout=key + "\n", stderr="")


def _expired(cmd, **kw):
    return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="Reauthentication failed. cannot prompt")


@pytest.fixture(autouse=True)
def _no_env_key(monkeypatch):
    monkeypatch.delenv("GENIUSCUT_GEMINI_API_KEY", raising=False)


def test_protect_round_trips_and_isnt_plain_text():
    blob = secrets.protect(b"AIza-secret")
    assert b"AIza-secret" not in blob
    assert secrets.unprotect(blob) == b"AIza-secret"


def test_a_key_read_from_secret_manager_is_cached_encrypted():
    assert secrets.gemini_api_key(run=_ok("AIza-gsm"), gcloud="gcloud") == "AIza-gsm"
    cached = config.data_dir() / "gemini_key.dpapi"
    assert cached.exists() and b"AIza-gsm" not in cached.read_bytes()


def test_an_expired_gcloud_login_falls_back_to_the_cached_key():
    secrets.gemini_api_key(run=_ok("AIza-gsm"), gcloud="gcloud")
    assert secrets.gemini_api_key(run=_expired, gcloud="gcloud") == "AIza-gsm"


def test_secret_manager_wins_when_it_answers_so_a_rotated_key_replaces_the_cache():
    secrets.gemini_api_key(run=_ok("AIza-old"), gcloud="gcloud")
    assert secrets.gemini_api_key(run=_ok("AIza-new"), gcloud="gcloud") == "AIza-new"
    assert secrets.gemini_api_key(run=_expired, gcloud="gcloud") == "AIza-new"


def test_no_cache_and_no_login_still_says_how_to_fix_it():
    with pytest.raises(secrets.MissingKeyError) as e:
        secrets.gemini_api_key(run=_expired, gcloud="gcloud")
    assert "gcloud auth login" in str(e.value)


def test_a_corrupt_cache_is_ignored_not_fatal():
    (config.data_dir()).mkdir(parents=True, exist_ok=True)
    (config.data_dir() / "gemini_key.dpapi").write_bytes(b"not dpapi")
    with pytest.raises(secrets.MissingKeyError):
        secrets.gemini_api_key(run=_expired, gcloud="gcloud")
