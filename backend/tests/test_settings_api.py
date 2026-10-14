"""GET/PUT /settings and POST /settings/test-key, for the panel's setup and settings screens."""

import subprocess
from types import SimpleNamespace

import anthropic
import httpx
import pytest
from fastapi.testclient import TestClient

from geniuscut import claude, config, settings
from server import create_app

SRC = {"project": "editor-proj", "secret": "ANTHROPIC_API_KEY", "version": "latest"}


@pytest.fixture(autouse=True)
def _no_env_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)


def app(tmp_path, **kw):
    token = config.get_or_create_token(tmp_path)
    a = create_app(token=token, stt_device=lambda: "cuda", library_dir=tmp_path / "library", **kw)
    return TestClient(a, base_url="http://127.0.0.1:8791"), {"Authorization": f"Bearer {token}"}


# ── GET / PUT /settings ────────────────────────────────────────────

@pytest.mark.parametrize("method, path", [("get", "/settings"), ("put", "/settings"), ("post", "/settings/test-key")])
def test_settings_routes_need_the_token(tmp_path, method, path):
    c, _ = app(tmp_path)
    assert getattr(c, method)(path).status_code == 401


def test_get_settings_returns_the_defaults(tmp_path):
    c, auth = app(tmp_path)
    r = c.get("/settings", headers=auth)
    assert r.status_code == 200
    assert r.json() == {"anthropic_key": {"project": "", "secret": "ANTHROPIC_API_KEY", "version": "latest"},
                        "monthly_limit_usd": 20, "setup_complete": False}


def test_put_settings_saves_and_returns_them(tmp_path):
    c, auth = app(tmp_path)
    body = {"anthropic_key": {**SRC, "project": "  editor-proj "}, "monthly_limit_usd": 100}
    r = c.put("/settings", json=body, headers=auth)
    assert r.status_code == 200, r.text
    assert r.json() == {"anthropic_key": SRC, "monthly_limit_usd": 100, "setup_complete": False}
    assert settings.load().anthropic_key.project == "editor-proj"
    assert c.get("/settings", headers=auth).json()["monthly_limit_usd"] == 100


@pytest.mark.parametrize("body", [
    {"anthropic_key": SRC, "monthly_limit_usd": 50},
    {"anthropic_key": {**SRC, "project": ""}, "monthly_limit_usd": 20},
    {"anthropic_key": {**SRC, "version": "--impersonate-service-account=x"}, "monthly_limit_usd": 20},
    {"anthropic_key": {**SRC, "secret": 5}, "monthly_limit_usd": 20},
])
def test_put_settings_rejects_invalid_values_and_keeps_the_old_ones(tmp_path, body):
    c, auth = app(tmp_path)
    r = c.put("/settings", json=body, headers=auth)
    assert r.status_code == 422
    assert not settings.path().exists()


def test_settings_never_carry_a_key(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-secret")
    settings.save(settings.Settings(anthropic_key=SRC))
    c, auth = app(tmp_path)
    assert "sk-ant" not in c.get("/settings", headers=auth).text


# ── POST /settings/test-key ────────────────────────────────────────

def test_test_key_uses_the_given_source(tmp_path):
    seen = []
    c, auth = app(tmp_path, check_key=lambda src: seen.append(src) or {"ok": True, "message": "Connected."})
    r = c.post("/settings/test-key", json={"anthropic_key": {**SRC, "project": "other-proj"}}, headers=auth)
    assert r.status_code == 200 and r.json() == {"ok": True, "message": "Connected."}
    assert seen[0].project == "other-proj"


def test_test_key_defaults_to_the_saved_source(tmp_path):
    settings.save(settings.Settings(anthropic_key=SRC))
    seen = []
    c, auth = app(tmp_path, check_key=lambda src: seen.append(src) or {"ok": True, "message": "Connected."})
    assert c.post("/settings/test-key", headers=auth).json()["ok"] is True
    assert seen[0].project == "editor-proj"


def test_test_key_with_an_invalid_source_says_why_without_calling_out(tmp_path):
    c, auth = app(tmp_path, check_key=lambda src: pytest.fail("must not run"))
    r = c.post("/settings/test-key", json={"anthropic_key": {**SRC, "project": ""}}, headers=auth)
    assert r.status_code == 200 and r.json()["ok"] is False and "project" in r.json()["message"]


# ── claude.check_key ───────────────────────────────────────────────

def _run(key):
    return lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, stdout=key + "\n", stderr="")


def _client(calls, error=None):
    def make(api_key):
        def retrieve(model_id):
            calls.append((api_key, model_id))
            if error:
                raise error
            return SimpleNamespace(id=model_id)
        return SimpleNamespace(models=SimpleNamespace(retrieve=retrieve))
    return make


def _status_error(cls, status, message):
    req = httpx.Request("GET", "https://api.anthropic.com/v1/models/claude-opus-5-5")
    body = {"type": "error", "error": {"type": "x", "message": message}}
    return cls(message, response=httpx.Response(status, request=req, json=body), body=body)


def test_check_key_fetches_from_gsm_and_makes_one_authenticated_call():
    calls = []
    result = claude.check_key(settings.KeySource(**SRC), run=_run("sk-ant-real"), gcloud="gcloud",
                              make_client=_client(calls))
    assert result["ok"] is True and "editor-proj" in result["message"]
    assert calls == [("sk-ant-real", "claude-opus-5-5")]
    assert "sk-ant-real" not in result["message"]


def test_check_key_ignores_the_env_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-env")
    calls = []
    claude.check_key(settings.KeySource(**SRC), run=_run("sk-gsm"), gcloud="gcloud", make_client=_client(calls))
    assert calls[0][0] == "sk-gsm"


def test_check_key_reports_a_rejected_key_without_revealing_it():
    err = _status_error(anthropic.AuthenticationError, 401, "invalid x-api-key sk-ant-bad")
    result = claude.check_key(settings.KeySource(**SRC), run=_run("sk-ant-bad"), gcloud="gcloud",
                              make_client=_client([], err))
    assert result["ok"] is False and "rejected" in result["message"]
    assert "sk-ant-bad" not in result["message"]


def test_check_key_reports_a_secret_manager_failure():
    def denied(cmd, **kw):
        return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="PERMISSION_DENIED")

    result = claude.check_key(settings.KeySource(**SRC), run=denied, gcloud="gcloud",
                              make_client=lambda **kw: pytest.fail("no key, no call"))
    assert result["ok"] is False and "PERMISSION_DENIED" in result["message"]


def test_check_key_reports_no_connection():
    req = httpx.Request("GET", "https://api.anthropic.com/v1/models/claude-opus-5-5")
    result = claude.check_key(settings.KeySource(**SRC), run=_run("sk-ant-x"), gcloud="gcloud",
                              make_client=_client([], anthropic.APIConnectionError(request=req)))
    assert result["ok"] is False and "reach" in result["message"]
