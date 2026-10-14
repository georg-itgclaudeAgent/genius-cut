"""Setup screen backend: gcloud discovery, the sign-in job, project/secret/version listing,
setup_complete, key_from_cache and the /usage tab. No real gcloud: fake run/Popen."""

import json
import os
import subprocess
import threading
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from geniuscut import config, secrets, settings, setup, spend
from server import create_app

SRC = {"project": "editor-proj", "secret": "ANTHROPIC_API_KEY", "version": "latest"}
UTC = timezone.utc


@pytest.fixture(autouse=True)
def _no_env_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)


def done(stdout="", code=0, stderr=""):
    return lambda cmd, **kw: subprocess.CompletedProcess(cmd, code, stdout=stdout, stderr=stderr)


class Recorder:
    """A fake subprocess.run that answers by the gcloud sub-command."""

    def __init__(self, answers):
        self.answers, self.calls = answers, []

    def __call__(self, cmd, **kw):
        self.calls.append((cmd, kw))
        for key, (code, out, err) in self.answers.items():
            if key in " ".join(cmd[1:]):
                return subprocess.CompletedProcess(cmd, code, stdout=out, stderr=err)
        raise AssertionError(f"unexpected gcloud call {cmd}")


def app(tmp_path, **kw):
    token = config.get_or_create_token(tmp_path)
    a = create_app(token=token, stt_device=lambda: "cuda", library_dir=tmp_path / "library", **kw)
    return TestClient(a, base_url="http://127.0.0.1:8791"), {"Authorization": f"Bearer {token}"}


# ── discovery ──────────────────────────────────────────────────────

def test_gcloud_on_path_wins():
    assert setup.find_gcloud(which=lambda n: "C:/sdk/gcloud.cmd" if n == "gcloud" else None,
                             isfile=lambda p: pytest.fail("PATH answered")) == "C:/sdk/gcloud.cmd"


def test_gcloud_at_the_standard_install_path_after_a_fresh_install(tmp_path):
    local = tmp_path / "Local"
    target = local / "Google" / "Cloud SDK" / "google-cloud-sdk" / "bin" / "gcloud.cmd"
    target.parent.mkdir(parents=True)
    target.write_text("@echo off")
    env = {"LOCALAPPDATA": str(local), "ProgramFiles": str(tmp_path / "PF")}
    assert setup.find_gcloud(which=lambda n: None, env=env) == str(target)


def test_gcloud_in_program_files(tmp_path):
    pf = tmp_path / "PF86"
    target = pf / "Google" / "Cloud SDK" / "google-cloud-sdk" / "bin" / "gcloud.cmd"
    target.parent.mkdir(parents=True)
    target.write_text("@echo off")
    assert setup.find_gcloud(which=lambda n: None, env={"ProgramFiles(x86)": str(pf)}) == str(target)


def test_no_gcloud_anywhere():
    assert setup.find_gcloud(which=lambda n: None, env={}) is None


def test_the_key_read_uses_the_same_discovery_with_a_timeout_and_no_stdin(monkeypatch):
    settings.save(settings.Settings(anthropic_key=SRC))
    monkeypatch.setattr(setup, "find_gcloud", lambda: "C:/fresh/gcloud.cmd")
    seen = []

    def run(cmd, **kw):
        seen.append((cmd, kw))
        return subprocess.CompletedProcess(cmd, 0, stdout="sk-ant-gsm\n", stderr="")

    assert secrets.anthropic_api_key(run=run) == "sk-ant-gsm"
    cmd, kw = seen[0]
    assert cmd[0] == "C:/fresh/gcloud.cmd"
    assert kw["timeout"] > 0 and kw["stdin"] == subprocess.DEVNULL


def test_a_hung_gcloud_during_the_key_read_is_a_missing_key_not_a_hang(monkeypatch):
    settings.save(settings.Settings(anthropic_key=SRC))

    def hang(cmd, **kw):
        raise subprocess.TimeoutExpired(cmd, kw.get("timeout"))

    with pytest.raises(secrets.MissingKeyError):
        secrets.anthropic_api_key(run=hang, gcloud="gcloud", source=settings.KeySource(**SRC), fresh_only=True)


def test_the_key_read_refuses_a_hand_edited_source_before_gcloud():
    settings.path().parent.mkdir(parents=True, exist_ok=True)
    settings.path().write_text(json.dumps({"anthropic_key": {**SRC, "project": "x&calc"}}), encoding="utf-8")
    with pytest.raises(secrets.MissingKeyError, match="setup"):
        secrets.anthropic_api_key(run=lambda *a, **k: pytest.fail("gcloud must not run"), gcloud="gcloud")


# ── GET /setup/gcloud ──────────────────────────────────────────────

def test_status_reports_path_version_and_account(tmp_path):
    run = Recorder({"--version": (0, "Google Cloud SDK 501.0.0\nbq 2.1.9\n", ""),
                    "config get-value account": (0, "editor@example.com\n", "")})
    c, auth = app(tmp_path, gcloud_run=run, find_gcloud=lambda: "C:/sdk/gcloud.cmd")
    r = c.get("/setup/gcloud", headers=auth)
    assert r.status_code == 200
    assert r.json() == {"installed": True, "path": "C:/sdk/gcloud.cmd", "version": "501.0.0",
                        "account": "editor@example.com"}
    assert all(kw["stdin"] == subprocess.DEVNULL and kw["timeout"] for _, kw in run.calls)


def test_status_with_no_account_signed_in(tmp_path):
    run = Recorder({"--version": (0, "Google Cloud SDK 501.0.0\n", ""),
                    "config get-value account": (0, "", "(unset)\n")})
    c, auth = app(tmp_path, gcloud_run=run, find_gcloud=lambda: "gcloud")
    assert c.get("/setup/gcloud", headers=auth).json()["account"] is None


def test_status_when_gcloud_is_missing(tmp_path):
    c, auth = app(tmp_path, gcloud_run=lambda *a, **k: pytest.fail("nothing to run"), find_gcloud=lambda: None)
    assert c.get("/setup/gcloud", headers=auth).json() == {"installed": False, "path": None, "version": None,
                                                            "account": None}


@pytest.mark.parametrize("path", ["/setup/gcloud", "/setup/login", "/setup/projects",
                                  "/setup/secrets?project=editor-proj",
                                  "/setup/versions?project=editor-proj&secret=K", "/usage"])
def test_setup_routes_need_the_token(tmp_path, path):
    c, _ = app(tmp_path)
    assert c.get(path).status_code == 401


# ── sign-in job ────────────────────────────────────────────────────

class FakeProc:
    def __init__(self, code=0, err="", hang=False):
        self.code, self.err, self.hang = code, err, hang
        self.release = threading.Event()
        self.pid, self.returncode, self.killed = 4242, None, False

    def communicate(self, timeout=None):
        if self.hang and not self.killed:
            raise subprocess.TimeoutExpired("gcloud", timeout)
        self.release.wait(5)
        self.returncode = self.code
        return "", self.err


def login_job(proc, popened):
    def popen(cmd, **kw):
        popened.append((cmd, kw))
        return proc

    def kill(p):
        p.killed = True

    return setup.Login(popen=popen, find=lambda: "C:/sdk/gcloud.cmd", kill=kill, timeout=300)


def test_login_runs_quiet_with_no_stdin_and_reports_done(tmp_path):
    proc, popened = FakeProc(), []
    job = login_job(proc, popened)
    c, auth = app(tmp_path, login=job)
    assert c.get("/setup/login", headers=auth).json()["state"] == "idle"
    r = c.post("/setup/login", headers=auth)
    assert r.status_code == 202 and r.json()["state"] == "running"
    cmd, kw = popened[0]
    assert cmd == ["C:/sdk/gcloud.cmd", "auth", "login", "--quiet"] and kw["stdin"] == subprocess.DEVNULL
    assert c.get("/setup/login", headers=auth).json()["state"] == "running"
    proc.release.set()
    job.join()
    assert c.get("/setup/login", headers=auth).json() == {"state": "done", "message": "Signed in."}


def test_only_one_login_at_a_time(tmp_path):
    proc, popened = FakeProc(), []
    job = login_job(proc, popened)
    c, auth = app(tmp_path, login=job)
    assert c.post("/setup/login", headers=auth).status_code == 202
    assert c.post("/setup/login", headers=auth).status_code == 409
    assert len(popened) == 1
    proc.release.set()
    job.join()
    proc2 = FakeProc()
    job.popen = lambda cmd, **kw: popened.append(cmd) or proc2
    assert c.post("/setup/login", headers=auth).status_code == 202  # a finished one can be retried
    proc2.release.set()
    job.join()


def test_a_failed_login_says_why():
    proc = FakeProc(code=1, err="Some noise\nERROR: (gcloud.auth.login) There was a problem.\n")
    proc.release.set()
    job = login_job(proc, [])
    job.start()
    job.join()
    assert job.status() == {"state": "failed", "message": "ERROR: (gcloud.auth.login) There was a problem."}


def test_a_login_left_open_is_killed_after_the_timeout():
    proc = FakeProc(hang=True)
    proc.release.set()
    job = login_job(proc, [])
    job.start()
    job.join()
    assert proc.killed
    st = job.status()
    assert st["state"] == "failed" and "5 minutes" in st["message"]


def test_login_without_gcloud_is_refused(tmp_path):
    job = setup.Login(popen=lambda *a, **k: pytest.fail("no gcloud"), find=lambda: None)
    c, auth = app(tmp_path, login=job)
    r = c.post("/setup/login", headers=auth)
    assert r.status_code == 502 and "Google Cloud CLI" in r.json()["detail"]


# ── listings ───────────────────────────────────────────────────────

def test_projects_listing(tmp_path):
    out = json.dumps([{"projectId": "zeta-proj", "name": "Zeta"}, {"projectId": "alpha-proj", "name": "Alpha"}])
    run = Recorder({"projects list": (0, out, "")})
    c, auth = app(tmp_path, gcloud_run=run, find_gcloud=lambda: "gcloud")
    r = c.get("/setup/projects", headers=auth)
    assert r.json() == {"projects": [{"id": "alpha-proj", "name": "Alpha"}, {"id": "zeta-proj", "name": "Zeta"}]}
    assert run.calls[0][0] == ["gcloud", "projects", "list", "--format=json"]


def test_secrets_listing(tmp_path):
    out = json.dumps([{"name": "projects/123/secrets/ANTHROPIC_API_KEY"}, {"name": "projects/123/secrets/OTHER"}])
    run = Recorder({"secrets list": (0, out, "")})
    c, auth = app(tmp_path, gcloud_run=run, find_gcloud=lambda: "gcloud")
    r = c.get("/setup/secrets", params={"project": "editor-proj"}, headers=auth)
    assert r.json() == {"secrets": ["ANTHROPIC_API_KEY", "OTHER"]}
    assert run.calls[0][0] == ["gcloud", "secrets", "list", "--project=editor-proj", "--format=json"]


def test_versions_listing(tmp_path):
    out = json.dumps([{"name": "projects/123/secrets/K/versions/2", "state": "ENABLED"},
                      {"name": "projects/123/secrets/K/versions/10", "state": "DISABLED"}])
    run = Recorder({"versions list": (0, out, "")})
    c, auth = app(tmp_path, gcloud_run=run, find_gcloud=lambda: "gcloud")
    r = c.get("/setup/versions", params={"project": "editor-proj", "secret": "K"}, headers=auth)
    assert r.json() == {"versions": [{"version": "10", "state": "disabled"}, {"version": "2", "state": "enabled"}]}
    assert run.calls[0][0] == ["gcloud", "secrets", "versions", "list", "K", "--project=editor-proj", "--format=json"]


def test_a_gcloud_error_is_a_502_with_its_message(tmp_path):
    run = Recorder({"projects list": (1, "", "ERROR: (gcloud.projects.list) You do not currently have an active account selected.\n")})
    c, auth = app(tmp_path, gcloud_run=run, find_gcloud=lambda: "gcloud")
    r = c.get("/setup/projects", headers=auth)
    assert r.status_code == 502 and "active account" in r.json()["detail"]


def test_a_hung_gcloud_listing_is_a_502(tmp_path):
    def hang(cmd, **kw):
        raise subprocess.TimeoutExpired(cmd, kw["timeout"])

    c, auth = app(tmp_path, gcloud_run=hang, find_gcloud=lambda: "gcloud")
    assert c.get("/setup/projects", headers=auth).status_code == 502


@pytest.mark.parametrize("params", [
    {"project": "x&calc"}, {"project": "Editor-Proj"}, {"project": "ab"}, {"project": "--impersonate-service-account=x"},
    {"project": "proj-1|whoami"}, {"project": "editor-proj-"}, {"project": "editor proj"},
])
def test_bad_projects_are_refused_before_gcloud(tmp_path, params):
    c, auth = app(tmp_path, gcloud_run=lambda *a, **k: pytest.fail("gcloud must not run"), find_gcloud=lambda: "gcloud")
    assert c.get("/setup/secrets", params=params, headers=auth).status_code == 422


@pytest.mark.parametrize("secret", ["a b", "K&calc", "K^", "--flag", "", "x" * 256, "K%PATH%"])
def test_bad_secret_names_are_refused_before_gcloud(tmp_path, secret):
    c, auth = app(tmp_path, gcloud_run=lambda *a, **k: pytest.fail("gcloud must not run"), find_gcloud=lambda: "gcloud")
    r = c.get("/setup/versions", params={"project": "editor-proj", "secret": secret}, headers=auth)
    assert r.status_code == 422


@pytest.mark.parametrize("version", ["latest", "1", "42"])
def test_valid_versions(version):
    settings.validate_key_source(settings.KeySource(project="editor-proj", version=version))


@pytest.mark.parametrize("version", ["Latest", "v1", "1.0", "-1", "latest&x", ""])
def test_bad_versions(version):
    with pytest.raises(ValueError):
        settings.validate_key_source(settings.KeySource(project="editor-proj", version=version))


# ── setup_complete ─────────────────────────────────────────────────

def test_setup_starts_incomplete():
    assert settings.load().setup_complete is False


def test_a_passing_key_test_saves_the_source_and_completes_setup(tmp_path):
    settings.save(settings.Settings(monthly_limit_usd=100))
    c, auth = app(tmp_path, check_key=lambda src: {"ok": True, "message": "Connected."})
    r = c.post("/settings/test-key", json={"anthropic_key": {**SRC, "project": " editor-proj "}}, headers=auth)
    assert r.json()["ok"] is True
    s = settings.load()
    assert s.setup_complete is True and s.anthropic_key.project == "editor-proj" and s.monthly_limit_usd == 100


def test_a_failing_key_test_changes_nothing(tmp_path):
    c, auth = app(tmp_path, check_key=lambda src: {"ok": False, "message": "rejected"})
    c.post("/settings/test-key", json={"anthropic_key": SRC}, headers=auth)
    assert settings.load().setup_complete is False and settings.load().anthropic_key.project == ""


def test_put_settings_cannot_mark_setup_complete(tmp_path):
    c, auth = app(tmp_path)
    r = c.put("/settings", json={"anthropic_key": SRC, "monthly_limit_usd": 20, "setup_complete": True}, headers=auth)
    assert r.status_code == 200 and r.json()["setup_complete"] is False


def test_put_settings_keeps_setup_complete_for_the_same_source_only(tmp_path):
    settings.save(settings.Settings(anthropic_key=SRC, setup_complete=True))
    c, auth = app(tmp_path)
    assert c.put("/settings", json={"anthropic_key": SRC, "monthly_limit_usd": 100},
                 headers=auth).json()["setup_complete"] is True
    other = {**SRC, "project": "other-proj"}
    assert c.put("/settings", json={"anthropic_key": other, "monthly_limit_usd": 100},
                 headers=auth).json()["setup_complete"] is False


# ── key_from_cache ─────────────────────────────────────────────────

windows = pytest.mark.skipif(os.name != "nt", reason="DPAPI is Windows-only")


@windows
def test_key_from_cache_is_true_only_when_the_cached_key_is_in_use(tmp_path):
    settings.save(settings.Settings(anthropic_key=SRC))
    secrets.anthropic_api_key(run=done("sk-ant-gsm\n"), gcloud="gcloud")
    assert secrets.key_from_cache() is False
    secrets.anthropic_api_key(run=done(code=1, stderr="Reauthentication failed."), gcloud="gcloud")
    assert secrets.key_from_cache() is True
    c, _ = app(tmp_path)
    assert c.get("/health").json()["ai"]["key_from_cache"] is True
    secrets.anthropic_api_key(run=done("sk-ant-gsm\n"), gcloud="gcloud")
    assert c.get("/health").json()["ai"]["key_from_cache"] is False


# ── /usage ─────────────────────────────────────────────────────────

def test_rows_carry_the_run_id_and_a_meter_makes_one_run():
    with spend.meter(kind="trim"):
        spend.record("gemini-2.5-flash-lite", 1_000_000, 0)
        spend.record("gemini-2.5-flash-lite", 1_000_000, 0)
    with spend.meter(kind="agent", run="run-a"):
        spend.record("claude-opus-5-5", 1000, 0)
    rows = [json.loads(x) for x in spend.ledger_path().read_text(encoding="utf-8").splitlines()]
    assert rows[0]["run"] == rows[1]["run"] and rows[0]["run"] != "run-a"
    assert rows[2]["run"] == "run-a"


def test_usage_groups_rows_by_run_newest_first():
    now = datetime(2026, 10, 14, 12, 0, tzinfo=UTC)
    with spend.meter(kind="agent", run="run-a"):
        for i in range(10):  # ten steps, one run
            spend.record("claude-opus-5-5", 100_000, 0, now=datetime(2026, 10, 3, 9, i, tzinfo=UTC))  # $0.40 each
    with spend.meter(kind="trim"):
        spend.record("gemini-2.5-flash-lite", 1_000_000, 0, now=datetime(2026, 10, 5, 9, 0, tzinfo=UTC))  # $0.10
    spend.record("gemini-2.5-flash-lite", 1_000_000, 0, now=datetime(2026, 9, 30, 9, 0, tzinfo=UTC))  # last month
    u = spend.usage(now=now)
    assert u["month_usd"] == pytest.approx(4.10) and u["limit_usd"] == 20.0 and u["limit_tier"] == 20
    assert u["resets_on"] == "2026-11-01" and u["run_count"] == 2
    assert [r["kind"] for r in u["runs"]] == ["trim", "agent"]
    agent = u["runs"][1]
    assert agent["model"] == "claude-opus-5-5" and agent["usd"] == pytest.approx(4.00)
    assert agent["at"].startswith("2026-10-03T09:00")


def test_usage_lists_the_last_ten_runs():
    for d in range(1, 13):
        with spend.meter(kind="trim"):
            spend.record("gemini-2.5-flash-lite", 1_000_000, 0, now=datetime(2026, 10, d, tzinfo=UTC))
    u = spend.usage(now=datetime(2026, 10, 14, tzinfo=UTC))
    assert u["run_count"] == 12 and len(u["runs"]) == 10
    assert u["runs"][0]["at"].startswith("2026-10-12")


def test_usage_route(tmp_path):
    settings.save(settings.Settings(monthly_limit_usd=100))
    with spend.meter(kind="trim"):
        spend.record("gemini-2.5-flash-lite", 1_000_000, 0)
    c, auth = app(tmp_path)
    body = c.get("/usage", headers=auth).json()
    assert body["limit_tier"] == 100 and body["run_count"] == 1 and len(body["runs"]) == 1
    assert set(body["runs"][0]) == {"at", "kind", "model", "usd"}
