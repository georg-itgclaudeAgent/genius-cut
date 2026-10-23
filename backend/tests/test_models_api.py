"""GET /models, PUT /settings/model, the merging PUT /settings, the selected model in /health, and the
Google Cloud (Vertex) sign-in job. Probes and gcloud are faked."""

import json
import subprocess
import threading

import pytest
from fastapi.testclient import TestClient

from geniuscut import catalog, config, settings, setup, spend
from server import create_app

SRC = {"project": "editor-proj", "secret": "ANTHROPIC_API_KEY", "version": "latest"}


@pytest.fixture(autouse=True)
def _no_env_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)


def fake_availability(probed=None):
    probed = probed if probed is not None else []
    return catalog.Availability(
        anthropic_count=lambda m: probed.append(("anthropic", m)),
        vertex_count=lambda m, p, r: probed.append(("vertex", m, p, r)),
        gemini_list=lambda: probed.append(("gemini",)) or {"gemini-3.8-flash"},
        adc=lambda: {"present": True, "quota_project": "agent-georg"},
        vertex_config=lambda: (settings.load().vertex.project, settings.load().vertex.region))


def app(tmp_path, **kw):
    kw.setdefault("availability", fake_availability())
    token = config.get_or_create_token(tmp_path)
    a = create_app(token=token, stt_device=lambda: "cuda", library_dir=tmp_path / "library", **kw)
    return TestClient(a, base_url="http://127.0.0.1:8791"), {"Authorization": f"Bearer {token}"}


@pytest.mark.parametrize("method, path", [("get", "/models"), ("put", "/settings/model"),
                                          ("post", "/setup/vertex-login"), ("get", "/setup/vertex-login")])
def test_routes_need_the_token(tmp_path, method, path):
    c, _ = app(tmp_path)
    assert getattr(c, method)(path).status_code == 401


# ── GET /models ────────────────────────────────────────────────────

def test_models_lists_the_catalog_with_states_and_the_selection(tmp_path):
    probed = []
    c, auth = app(tmp_path, availability=fake_availability(probed))
    body = c.get("/models", headers=auth).json()
    assert body["selected"] == "anthropic:claude-opus-5-5"
    assert [m["id"] for m in body["models"]] == [e.id for e in catalog.ENTRIES]
    by_id = {m["id"]: m for m in body["models"]}
    assert by_id["gemini:gemini-3.8-flash"]["state"] == "ok"
    assert by_id["gemini:gemini-3.7-flash"]["state"] == "blocked"
    assert by_id["vertex:claude-opus-5-5"] == {
        "id": "vertex:claude-opus-5-5", "label": "Claude Opus 5.5 (Google Cloud)", "provider": "vertex",
        "group": "Claude (Google Cloud)", "price": {"input": 4.00, "output": 20.00},
        "usd_per_minute": pytest.approx(spend.estimate_per_minute("vertex:claude-opus-5-5")),
        "state": "ok", "message": "Enabled"}
    assert body["vertex"]["adc"] is True
    n = len(probed)
    c.get("/models", headers=auth)
    assert len(probed) == n  # cached
    c.get("/models?refresh=1", headers=auth)
    assert len(probed) == 2 * n


def test_models_probe_vertex_in_the_saved_project_and_region(tmp_path):
    probed = []
    c, auth = app(tmp_path, availability=fake_availability(probed))
    c.put("/settings", json={"vertex": {"project": "other-proj", "region": "us-east5"}}, headers=auth)
    c.get("/models", headers=auth)
    assert ("vertex", "claude-opus-5-5", "other-proj", "us-east5") in probed


# ── PUT /settings/model ────────────────────────────────────────────

def test_switching_the_model_saves_it_and_health_follows(tmp_path):
    c, auth = app(tmp_path)
    r = c.put("/settings/model", json={"model": "gemini:gemini-3.8-flash"}, headers=auth)
    assert r.status_code == 200 and r.json()["model"] == "gemini:gemini-3.8-flash"
    assert settings.load().model == "gemini:gemini-3.8-flash"
    assert c.get("/models", headers=auth).json()["selected"] == "gemini:gemini-3.8-flash"
    ai = c.get("/health").json()["ai"]
    assert (ai["model_id"], ai["label"], ai["provider"]) == ("gemini:gemini-3.8-flash", "Gemini 3.8 Flash", "gemini")
    assert ai["usd_per_minute"] == pytest.approx(spend.estimate_per_minute("gemini:gemini-3.8-flash"))
    c.put("/settings/model", json={"model": "vertex:claude-fable-5-1"}, headers=auth)
    ai = c.get("/health").json()["ai"]
    assert (ai["model_id"], ai["provider"]) == ("vertex:claude-fable-5-1", "vertex")
    assert ai["usd_per_minute"] == pytest.approx(spend.estimate_per_minute("vertex:claude-fable-5-1"))


@pytest.mark.parametrize("bad", ["claude-opus-5-5", "gemini:gemini-2.5-flash", "openai:gpt", "", "anthropic:"])
def test_a_model_outside_the_catalog_is_refused(tmp_path, bad):
    c, auth = app(tmp_path)
    r = c.put("/settings/model", json={"model": bad}, headers=auth)
    assert r.status_code == 422 and "Unknown AI model" in r.json()["detail"]
    assert not settings.path().exists()


def test_a_stale_stored_model_falls_back_to_the_default(tmp_path):
    settings.path().parent.mkdir(parents=True, exist_ok=True)
    settings.path().write_text(json.dumps({"model": "anthropic:claude-opus-4-1", "monthly_limit_usd": 100,
                                           "vertex": {"project": "BAD PROJECT", "region": "global"}}))
    s = settings.load()
    assert s.model == "anthropic:claude-opus-5-5" and s.monthly_limit_usd == 100
    assert s.vertex == settings.VertexSettings()  # a bad vertex block falls back whole
    c, auth = app(tmp_path)
    assert c.get("/settings", headers=auth).json()["model"] == "anthropic:claude-opus-5-5"


# ── PUT /settings merges ───────────────────────────────────────────

def test_put_settings_merges_and_keeps_model_and_vertex(tmp_path):
    c, auth = app(tmp_path)
    c.put("/settings/model", json={"model": "gemini:gemini-3.1-pro-preview"}, headers=auth)
    c.put("/settings", json={"vertex": {"region": "europe-west1"}}, headers=auth)
    # what "Test and save" sends: the key source and the limit only
    r = c.put("/settings", json={"anthropic_key": SRC, "monthly_limit_usd": 100}, headers=auth)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["model"] == "gemini:gemini-3.1-pro-preview"
    assert body["vertex"] == {"project": "agent-georg", "region": "europe-west1"}
    assert body["anthropic_key"] == SRC and body["monthly_limit_usd"] == 100
    r = c.put("/settings", json={"monthly_limit_usd": 20}, headers=auth)
    assert r.json()["anthropic_key"] == SRC and r.json()["model"] == "gemini:gemini-3.1-pro-preview"


def test_put_settings_can_set_the_model_too(tmp_path):
    c, auth = app(tmp_path)
    assert c.put("/settings", json={"model": "vertex:claude-haiku-5-5"}, headers=auth).json()["model"] == \
        "vertex:claude-haiku-5-5"
    r = c.put("/settings", json={"model": "nope"}, headers=auth)
    assert r.status_code == 422 and settings.load().model == "vertex:claude-haiku-5-5"


@pytest.mark.parametrize("vertex, message", [
    ({"project": "x"}, "project ID for Vertex"),
    ({"project": "agent-georg & calc"}, "project ID for Vertex"),
    ({"region": "us-east5; del"}, "region"),
    ({"region": ""}, "region"),
])
def test_put_settings_refuses_a_bad_vertex_block(tmp_path, vertex, message):
    c, auth = app(tmp_path)
    r = c.put("/settings", json={"vertex": vertex}, headers=auth)
    assert r.status_code == 422 and message in r.json()["detail"]
    assert not settings.path().exists()


def test_put_settings_keeps_setup_complete_only_for_the_same_key_source(tmp_path):
    settings.save(settings.Settings(anthropic_key=SRC, setup_complete=True))
    c, auth = app(tmp_path)
    assert c.put("/settings", json={"model": "gemini:gemini-3.8-flash"}, headers=auth).json()["setup_complete"] is True
    assert c.put("/settings", json={"setup_complete": False}, headers=auth).json()["setup_complete"] is True
    r = c.put("/settings", json={"anthropic_key": {**SRC, "project": "other-proj"}}, headers=auth)
    assert r.json()["setup_complete"] is False


def test_changing_the_vertex_block_drops_the_cached_vertex_states(tmp_path):
    probed = []
    c, auth = app(tmp_path, availability=fake_availability(probed))
    c.get("/models", headers=auth)
    before = sum(1 for p in probed if p[0] == "vertex")
    c.put("/settings", json={"vertex": {"region": "us-east5"}}, headers=auth)
    c.get("/models", headers=auth)
    assert sum(1 for p in probed if p[0] == "vertex") == 2 * before
    assert sum(1 for p in probed if p[0] == "anthropic") == 4


# ── the panel's cost names the model ───────────────────────────────

def test_run_cost_names_the_model_by_catalog_id_label_and_provider():
    from geniuscut import llm
    with spend.meter() as m:
        spend.record("vertex:claude-sonnet-5-5", 1000, 100)
    cost = llm.run_cost(m)
    assert (cost.model, cost.label, cost.provider) == ("vertex:claude-sonnet-5-5", "Claude Sonnet 5.5 (Google Cloud)",
                                                       "vertex")
    assert cost.usd == pytest.approx((1000 * 2 + 100 * 10) / 1e6)


def test_legacy_bare_rows_read_as_catalog_ids_in_usage():
    path = spend.ledger_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"ts": "2026-10-05T01:00:00+00:00", "model": "claude-opus-5-5", "kind": "agent",
                                "input_tokens": 1, "output_tokens": 1, "usd": 0.25}) + "\n", encoding="utf-8")
    from datetime import datetime, timezone
    run = spend.usage(now=datetime(2026, 10, 9, tzinfo=timezone.utc))["runs"][0]
    assert (run["model"], run["provider"], run["label"]) == ("anthropic:claude-opus-5-5", "anthropic",
                                                             "Claude Opus 5.5 (Anthropic)")


# ── Google Cloud (Vertex) sign-in ──────────────────────────────────

class FakeProc:
    def __init__(self, code=0, err="", hang=False):
        self.code, self.err, self.hang = code, err, hang
        self.release = threading.Event()
        self.release.set()
        self.pid, self.returncode, self.killed = 4242, None, False

    def communicate(self, timeout=None):
        if self.hang and not self.killed:
            raise subprocess.TimeoutExpired("gcloud", timeout)
        self.release.wait(5)
        self.returncode = self.code
        return "", self.err


def vertex_job(procs, popened, done=None, find=lambda: "C:/sdk/gcloud.cmd"):
    def popen(cmd, **kw):
        popened.append((cmd, kw))
        return procs[len(popened) - 1]

    def kill(p):
        p.killed = True

    return setup.VertexLogin(popen=popen, find=find, kill=kill, timeout=300, step_timeout=60,
                             on_done=(lambda: done.append(True)) if done is not None else None)


def test_vertex_sign_in_runs_adc_login_then_sets_the_quota_project(tmp_path):
    popened, done = [], []
    first = FakeProc()
    first.release.clear()
    job = vertex_job([first, FakeProc()], popened, done)
    c, auth = app(tmp_path, vertex_login=job)
    assert c.get("/setup/vertex-login", headers=auth).json() == {"state": "idle", "message": ""}
    r = c.post("/setup/vertex-login", headers=auth)
    assert r.status_code == 202 and r.json()["state"] == "running" and "browser" in r.json()["message"]
    assert c.post("/setup/vertex-login", headers=auth).status_code == 409
    first.release.set()
    job.join(5)
    assert [p[0] for p in popened] == [
        ["C:/sdk/gcloud.cmd", "auth", "application-default", "login", "--quiet"],
        ["C:/sdk/gcloud.cmd", "auth", "application-default", "set-quota-project", "agent-georg", "--quiet"]]
    assert all(p[1]["stdin"] == subprocess.DEVNULL for p in popened)
    st = c.get("/setup/vertex-login", headers=auth).json()
    assert st["state"] == "done" and "agent-georg" in st["message"] and done == [True]


def test_vertex_sign_in_uses_the_given_or_saved_project(tmp_path):
    popened = []
    job = vertex_job([FakeProc(), FakeProc()], popened)
    c, auth = app(tmp_path, vertex_login=job)
    c.put("/settings", json={"vertex": {"project": "saved-proj"}}, headers=auth)
    c.post("/setup/vertex-login", headers=auth)
    job.join(5)
    assert popened[1][0][4] == "saved-proj"
    assert c.post("/setup/vertex-login", json={"project": "-x"}, headers=auth).status_code == 422


def test_a_failed_login_step_stops_and_reports_the_error_line(tmp_path):
    popened = []
    job = vertex_job([FakeProc(code=1, err="ERROR: (gcloud.auth.application-default.login) cancelled\n")], popened)
    c, auth = app(tmp_path, vertex_login=job)
    c.post("/setup/vertex-login", headers=auth)
    job.join(5)
    assert len(popened) == 1
    assert c.get("/setup/vertex-login", headers=auth).json() == {
        "state": "failed", "message": "ERROR: (gcloud.auth.application-default.login) cancelled"}


def test_a_failed_quota_step_is_reported(tmp_path):
    popened, done = [], []
    job = vertex_job([FakeProc(), FakeProc(code=1, err="ERROR: permission denied on agent-georg")], popened, done)
    c, auth = app(tmp_path, vertex_login=job)
    c.post("/setup/vertex-login", headers=auth)
    job.join(5)
    st = c.get("/setup/vertex-login", headers=auth).json()
    assert st["state"] == "failed" and "permission denied" in st["message"] and done == []


def test_a_hanging_sign_in_is_killed(tmp_path):
    popened = []
    proc = FakeProc(hang=True)
    job = vertex_job([proc], popened)
    c, auth = app(tmp_path, vertex_login=job)
    c.post("/setup/vertex-login", headers=auth)
    job.join(5)
    assert proc.killed and c.get("/setup/vertex-login", headers=auth).json()["state"] == "failed"


def test_vertex_sign_in_without_gcloud_is_502(tmp_path):
    job = vertex_job([], [], find=lambda: None)
    c, auth = app(tmp_path, vertex_login=job)
    r = c.post("/setup/vertex-login", headers=auth)
    assert r.status_code == 502 and "gcloud is not installed" in r.json()["detail"]


def test_a_finished_sign_in_drops_the_cached_vertex_states_in_the_server(tmp_path):
    probed = []
    job = vertex_job([FakeProc(), FakeProc()], [])  # no on_done of its own: the server wires one
    c, auth = app(tmp_path, availability=fake_availability(probed), vertex_login=job)
    c.get("/models", headers=auth)
    before = sum(1 for p in probed if p[0] == "vertex")
    c.post("/setup/vertex-login", headers=auth)
    job.join(5)
    c.get("/models", headers=auth)
    assert sum(1 for p in probed if p[0] == "vertex") == 2 * before
    assert sum(1 for p in probed if p[0] == "anthropic") == 4
