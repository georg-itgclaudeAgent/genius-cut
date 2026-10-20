"""The agent loop (plan task 2): Claude's side of an instruction run, with a fake Anthropic client."""

import json
from datetime import date
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from geniuscut import agent, claude, config, secrets, spend
from server import create_app

SELECTION = {"clipIds": ["V1@0#a", "A1@0#b"], "startS": 0, "endS": 30}
SEQUENCE = {"sequenceId": "seq-1", "name": "Edit", "durationS": 600}


@pytest.fixture(autouse=True)
def _no_env(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)


def usage(inp=1000, out=500, cw=0, cr=0):
    return SimpleNamespace(input_tokens=inp, output_tokens=out, cache_creation_input_tokens=cw,
                           cache_read_input_tokens=cr)


def text(t):
    return SimpleNamespace(type="text", text=t)


def thinking(t="hmm"):
    return SimpleNamespace(type="thinking", thinking=t, signature="sig")


def tool(id_, name, inp=None):
    return SimpleNamespace(type="tool_use", id=id_, name=name, input=inp or {})


def reply(*blocks, stop="end_turn", model="claude-opus-5-5", u=None, details=None):
    return SimpleNamespace(content=list(blocks), stop_reason=stop, stop_details=details, model=model,
                           usage=u or usage())


class FakeClient:
    """client.beta.messages.stream(**kw) as a context manager; replies scripted in order."""

    def __init__(self, *replies):
        self.replies, self.calls = list(replies), []
        outer = self

        class Stream:
            def __init__(self, response):
                self.response = response

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def get_final_message(self):
                return self.response

        def stream(**kw):
            outer.calls.append({**kw, "messages": list(kw["messages"])})
            if not outer.replies:
                raise AssertionError("no scripted reply left")
            return Stream(outer.replies.pop(0))

        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=stream))


def app(tmp_path, client, **kw):
    made = []

    def make():
        made.append(1)
        return client

    token = config.get_or_create_token(tmp_path)
    a = create_app(token=token, stt_device=lambda: "cuda", library_dir=tmp_path / "library",
                   agent_runs=agent.Runs(make_client=make), **kw)
    c = TestClient(a, base_url="http://127.0.0.1:8791")
    c.made = made
    return c, {"Authorization": f"Bearer {token}"}


def start(c, auth, instruction="Add a marker at every product mention"):
    return c.post("/agent/runs", json={"instruction": instruction, "selection": SELECTION, "sequence": SEQUENCE},
                  headers=auth)


def results(c, auth, run_id, *items):
    body = {"results": [{"tool_use_id": i, "content": content, "is_error": err} for i, content, err in items]}
    return c.post(f"/agent/runs/{run_id}/results", json=body, headers=auth)


def ledger():
    return [json.loads(x) for x in spend.ledger_path().read_text(encoding="utf-8").splitlines()]


# ── tools and request shape ────────────────────────────────────────

def test_the_tools_offered_are_phase_1_plus_propose_filler_cuts_never_undo():
    names = [t["name"] for t in agent.TOOLS]
    assert names == ["get_sequence", "get_transcript", "wait_transcript", "add_markers", "cut_ranges",
                     "propose_filler_cuts"]
    assert all(t["input_schema"]["type"] == "object" and t["description"] for t in agent.TOOLS)
    assert "undo_last_turn" not in json.dumps(agent.TOOLS)
    assert set(agent.TOOL_KINDS) == set(names)


def test_first_step_request_shape(tmp_path):
    fake = FakeClient(reply(thinking(), tool("t1", "get_sequence"), stop="tool_use"))
    c, auth = app(tmp_path, fake)
    r = start(c, auth)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["state"] == "tool_calls" and body["run_id"]
    assert body["tool_calls"] == [{"id": "t1", "name": "get_sequence", "input": {}}]
    kw = fake.calls[0]
    assert kw["model"] == "claude-opus-5-5" and kw["max_tokens"] == 16000
    assert kw["output_config"] == {"effort": "high"} and kw["tool_choice"] == {"type": "auto"}
    assert kw["cache_control"] == {"type": "ephemeral"}
    assert kw["betas"] == [claude.FALLBACK_BETA] and kw["fallbacks"] == "default"
    assert "thinking" not in kw
    assert [t["name"] for t in kw["tools"]] == [t["name"] for t in agent.TOOLS]
    assert "selected" in kw["system"].lower()
    first = kw["messages"][0]
    assert first["role"] == "user"
    assert "product mention" in first["content"] and "V1@0#a" in first["content"] and "seq-1" in first["content"]


def test_the_system_prompt_covers_the_run_rules():
    s = agent.SYSTEM.lower()
    for phrase in ["this also moves", "effects will be lost", "propose_filler_cuts", "trim", "approved"]:
        assert phrase in s


# ── the loop ───────────────────────────────────────────────────────

def test_results_feed_the_next_step_and_history_is_append_only(tmp_path):
    step1 = reply(thinking("plan it"), text("Reading."), tool("t1", "get_sequence"),
                  tool("t2", "get_transcript", {"clipIds": ["A1@0#b"]}), stop="tool_use")
    fake = FakeClient(step1, reply(thinking(), text("1. Marker at 0:12 'Product'"), stop="end_turn"))
    c, auth = app(tmp_path, fake)
    run_id = start(c, auth).json()["run_id"]
    r = results(c, auth, run_id, ("t2", "words...", False), ("t1", "boom", True))
    assert r.status_code == 200, r.text
    assert r.json()["state"] == "plan" and r.json()["text"] == "1. Marker at 0:12 'Product'"
    first, second = fake.calls[0]["messages"], fake.calls[1]["messages"]
    assert second[:len(first)] == first  # earlier turns untouched
    assistant = second[1]
    assert assistant["role"] == "assistant" and assistant["content"] is step1.content  # whole, thinking included
    user = second[2]
    assert user["role"] == "user"
    assert user["content"] == [
        {"type": "tool_result", "tool_use_id": "t1", "content": "boom", "is_error": True},
        {"type": "tool_result", "tool_use_id": "t2", "content": "words...", "is_error": False},
    ]


@pytest.mark.parametrize("items", [
    [("t1", "x", False)],                                           # missing t2
    [("t1", "x", False), ("t2", "y", False), ("t3", "z", False)],   # extra
    [("t1", "x", False), ("t1", "x", False)],                       # duplicate, t2 missing
    [("t1", "x", False), ("t2", "y", False), ("t2", "y", False)],   # duplicate
])
def test_every_tool_use_needs_exactly_one_result(tmp_path, items):
    fake = FakeClient(reply(tool("t1", "get_sequence"), tool("t2", "get_sequence"), stop="tool_use"),
                      reply(text("plan"), stop="end_turn"))
    c, auth = app(tmp_path, fake)
    run_id = start(c, auth).json()["run_id"]
    r = results(c, auth, run_id, *items)
    assert r.status_code == 422
    assert len(fake.calls) == 1
    ok = results(c, auth, run_id, ("t1", "a", False), ("t2", "b", False))  # the run still waits
    assert ok.status_code == 200 and ok.json()["state"] == "plan"


def test_plan_then_approve_then_act_then_done(tmp_path):
    fake = FakeClient(
        reply(text("1. Add a marker at 0:12."), stop="end_turn"),
        reply(tool("t9", "add_markers", {"sequenceId": "seq-1", "markers": [{"atS": 12, "name": "P"}]}), stop="tool_use"),
        reply(text("Added 1 marker."), stop="end_turn"),
    )
    c, auth = app(tmp_path, fake)
    first = start(c, auth).json()
    assert first["state"] == "plan" and first["text"] == "1. Add a marker at 0:12."
    run_id = first["run_id"]
    r = c.post(f"/agent/runs/{run_id}/approve", headers=auth)
    assert r.status_code == 200 and r.json()["state"] == "tool_calls"
    approved = fake.calls[1]["messages"][-1]
    assert approved == {"role": "user", "content": "Approved: do exactly this plan."}
    r = results(c, auth, run_id, ("t9", '{"ids": ["m1"]}', False))
    assert r.json()["state"] == "done" and r.json()["text"] == "Added 1 marker."
    assert results(c, auth, run_id, ("t9", "x", False)).status_code == 404  # a finished run is gone


def test_approve_only_after_a_plan(tmp_path):
    fake = FakeClient(reply(tool("t1", "get_sequence"), stop="tool_use"))
    c, auth = app(tmp_path, fake)
    run_id = start(c, auth).json()["run_id"]
    assert c.post(f"/agent/runs/{run_id}/approve", headers=auth).status_code == 409


def test_results_only_when_tool_calls_are_waiting(tmp_path):
    fake = FakeClient(reply(text("plan"), stop="end_turn"))
    c, auth = app(tmp_path, fake)
    run_id = start(c, auth).json()["run_id"]
    assert results(c, auth, run_id, ("t1", "x", False)).status_code == 409


def test_a_refusal_ends_the_run_without_appending(tmp_path):
    fake = FakeClient(reply(tool("t1", "get_sequence"), stop="tool_use"),
                      reply(text("I can't"), stop="refusal", details=SimpleNamespace(category="cyber")))
    runs = agent.Runs(make_client=lambda: fake)
    first = runs.start("x", SELECTION, SEQUENCE)
    run = runs._runs[first["run_id"]]
    history = run.messages
    r = runs.results(first["run_id"], [{"tool_use_id": "t1", "content": "ok", "is_error": False}])
    assert r["state"] == "stopped" and r["reason"] == "refusal" and r["tool_calls"] == []
    assert [m["role"] for m in history] == ["user", "assistant", "user"]  # the refused reply isn't appended
    assert first["run_id"] not in runs._runs


def test_a_reply_cut_off_at_max_tokens_is_not_executed(tmp_path):
    fake = FakeClient(reply(tool("t1", "cut_ranges", {"sequenceId": "s"}), stop="max_tokens"))
    c, auth = app(tmp_path, fake)
    body = start(c, auth).json()
    assert body["state"] == "stopped" and body["reason"] == "max_tokens" and body["tool_calls"] == []
    assert "cut off" in body["message"]
    assert results(c, auth, body["run_id"], ("t1", "x", False)).status_code == 404


def test_propose_filler_cuts_is_terminal(tmp_path):
    fake = FakeClient(reply(tool("t1", "propose_filler_cuts", {"instructions": "trim the ums"}), stop="tool_use"))
    c, auth = app(tmp_path, fake)
    body = start(c, auth, "trim the ums").json()
    assert body["state"] == "tool_calls" and body["tool_calls"][0]["name"] == "propose_filler_cuts"
    assert results(c, auth, body["run_id"], ("t1", "review opened", False)).status_code == 404


def test_the_25_step_cap(tmp_path):
    fake = FakeClient(*[reply(tool(f"t{i}", "get_sequence"), stop="tool_use") for i in range(30)])
    c, auth = app(tmp_path, fake)
    body = start(c, auth).json()
    for _ in range(24):
        body = results(c, auth, body["run_id"], (body["tool_calls"][0]["id"], "ok", False)).json()
        assert body["state"] == "tool_calls"
    body = results(c, auth, body["run_id"], (body["tool_calls"][0]["id"], "ok", False)).json()
    assert body["state"] == "stopped" and body["reason"] == "step_cap"
    assert len(fake.calls) == 25


def test_the_client_is_made_once_per_run(tmp_path):
    fake = FakeClient(reply(tool("t1", "get_sequence"), stop="tool_use"),
                      reply(tool("t2", "get_sequence"), stop="tool_use"), reply(text("plan"), stop="end_turn"))
    c, auth = app(tmp_path, fake)
    run_id = start(c, auth).json()["run_id"]
    results(c, auth, run_id, ("t1", "a", False))
    results(c, auth, run_id, ("t2", "b", False))
    assert len(c.made) == 1 and len(fake.calls) == 3


def test_a_missing_key_stops_the_run(tmp_path):
    def no_key():
        raise secrets.MissingKeyError("No Anthropic API key is set up.")

    token = config.get_or_create_token(tmp_path)
    a = create_app(token=token, stt_device=lambda: "cuda", agent_runs=agent.Runs(make_client=no_key))
    c = TestClient(a, base_url="http://127.0.0.1:8791")
    body = start(c, {"Authorization": f"Bearer {token}"}).json()
    assert body["state"] == "stopped" and body["reason"] == "key" and "set up" in body["message"]


# ── lost runs, cancel ──────────────────────────────────────────────

def test_unknown_runs_are_lost(tmp_path):
    c, auth = app(tmp_path, FakeClient())
    for r in (results(c, auth, "nope", ("t1", "x", False)), c.post("/agent/runs/nope/approve", headers=auth)):
        assert r.status_code == 404 and r.json()["detail"] == "This run was lost; send the instruction again."


def test_cancel_discards_the_run(tmp_path):
    fake = FakeClient(reply(tool("t1", "get_sequence"), stop="tool_use"))
    c, auth = app(tmp_path, fake)
    run_id = start(c, auth).json()["run_id"]
    assert c.delete(f"/agent/runs/{run_id}", headers=auth).json() == {"ok": True}
    assert results(c, auth, run_id, ("t1", "x", False)).status_code == 404
    assert c.delete(f"/agent/runs/{run_id}", headers=auth).status_code == 200  # idempotent


@pytest.mark.parametrize("method, path", [("post", "/agent/runs"), ("post", "/agent/runs/x/results"),
                                          ("post", "/agent/runs/x/approve"), ("delete", "/agent/runs/x")])
def test_agent_routes_need_the_token(tmp_path, method, path):
    c, _ = app(tmp_path, FakeClient())
    assert getattr(c, method)(path).status_code == 401


def test_an_empty_instruction_is_refused(tmp_path):
    c, auth = app(tmp_path, FakeClient())
    assert c.post("/agent/runs", json={"instruction": "  "}, headers=auth).status_code == 422


# ── spend ──────────────────────────────────────────────────────────

def test_cache_prices_for_opus_5_5():
    on = date(2026, 10, 14)
    assert spend.cost_usd("claude-opus-5-5", 0, 0, on=on, cache_read=1_000_000) == pytest.approx(0.20)
    assert spend.cost_usd("claude-opus-5-5", 0, 0, on=on, cache_write=1_000_000) == pytest.approx(5.00)


def test_each_step_is_recorded_under_the_answering_model_with_cache_tokens(tmp_path):
    fake = FakeClient(
        reply(tool("t1", "get_sequence"), stop="tool_use", u=usage(1000, 500, cw=2000, cr=10_000)),
        reply(text("plan"), stop="end_turn", model="claude-fallback-model", u=usage(100, 50, cr=20_000)),
    )
    c, auth = app(tmp_path, fake)
    first = start(c, auth).json()
    body = results(c, auth, first["run_id"], ("t1", "ok", False)).json()
    rows = ledger()
    assert [r["model"] for r in rows] == ["claude-opus-5-5", "claude-fallback-model"]
    assert all(r["run"] == first["run_id"] and r["kind"] == "agent" for r in rows)
    assert (rows[0]["cache_write_tokens"], rows[0]["cache_read_tokens"]) == (2000, 10_000)
    step1 = (1000 * 4 + 2000 * 5 + 10_000 * 0.20 + 500 * 20) / 1e6
    step2 = (100 * 4 + 20_000 * 0.20 + 50 * 20) / 1e6  # an unpriced fallback is priced as Opus 5.5
    assert rows[0]["usd"] == pytest.approx(step1) and rows[1]["usd"] == pytest.approx(step2)
    assert first["cost"]["usd"] == pytest.approx(step1)
    assert body["cost"]["usd"] == pytest.approx(step1 + step2)  # the run's total so far
    assert body["cost"]["model"] == "claude-fallback-model"
    assert spend.usage()["run_count"] == 1


def test_the_gate_estimates_a_step_from_the_previous_usage(tmp_path, monkeypatch):
    with spend.meter(kind="trim"):
        spend.record("claude-opus-5-5", 1_750_000, 0)  # $7.00 so far this month
    # Step 1 reads 3.5M cached tokens: the next step resends all of it, ~$14 + $0.32 worst-case output.
    fake = FakeClient(reply(tool("t1", "get_sequence"), stop="tool_use", u=usage(1000, 100, cr=3_500_000)),
                      reply(text("never"), stop="end_turn"))
    c, auth = app(tmp_path, fake)
    first = start(c, auth).json()
    assert first["state"] == "tool_calls"
    body = results(c, auth, first["run_id"], ("t1", "ok", False)).json()
    assert body["state"] == "stopped" and body["reason"] == "limit"
    assert body["message"].startswith("Partial monthly limit reached.")
    assert len(fake.calls) == 1  # nothing sent


def test_the_first_step_is_gated_too(tmp_path):
    with spend.meter(kind="trim"):
        spend.record("claude-opus-5-5", 5_000_000, 0)  # $20.00: the limit
    fake = FakeClient()
    c, auth = app(tmp_path, fake)
    body = start(c, auth).json()
    assert body["state"] == "stopped" and body["reason"] == "limit" and fake.calls == []

# ── a rejected key, effect loss ────────────────────────────────────

KEY_REJECTED = "Your key was rejected — check the secret, or sign in again in Settings."


def _auth_error():
    import anthropic
    import httpx
    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    body = {"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}}
    return anthropic.AuthenticationError("invalid x-api-key", response=httpx.Response(401, request=req, json=body),
                                         body=body)


class RejectingClient:
    """client.beta.messages.stream / create raise what the Anthropic SDK raises for a bad key."""

    def __init__(self):
        def boom(**kw):
            raise _auth_error()
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=boom, create=boom))


def test_a_rejected_key_stops_the_run_with_the_plain_message(tmp_path):
    c, auth = app(tmp_path, RejectingClient())
    body = start(c, auth).json()
    assert body["state"] == "stopped" and body["reason"] == "key"
    assert body["message"] == KEY_REJECTED


def test_cut_ranges_offers_accept_effect_loss_as_the_panel_and_mcp_do():
    cut = next(t for t in agent.TOOLS if t["name"] == "cut_ranges")["input_schema"]
    assert cut["properties"]["acceptEffectLoss"]["type"] == "boolean"
    assert "acceptEffectLoss" not in cut["required"]


def test_the_system_prompt_says_transitions_cant_be_undone_by_genius_cut():
    s = " ".join(agent.SYSTEM.split())
    assert "Genius Cut's Undo can't take a transition off" in s
    assert "the plan must say so" in s


def test_the_system_prompt_ties_effect_loss_to_the_approved_plan():
    s = " ".join(agent.SYSTEM.split())
    assert "whose get_sequence `effects` aren't empty" in s
    assert 'the plan must say "effects will be lost on <clips>"' in s
    assert "only after the user approved that plan, pass acceptEffectLoss: true to cut_ranges" in s
