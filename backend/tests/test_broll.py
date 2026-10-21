"""B-roll markers with Envato search: the Envato MCP server rides along on every agent step (Anthropic's MCP
connector runs it server-side), its blocks never reach the panel, and a run still works when Envato is off or down."""

from types import SimpleNamespace

import anthropic
import httpx
import pytest

from geniuscut import agent, claude, spend
from tests.test_agent import SELECTION, SEQUENCE, FakeClient, ledger, reply, text, thinking, tool, usage


def mcp_use(id_="m1", query="city skyline night"):
    return SimpleNamespace(type="mcp_tool_use", id=id_, name="search_stock_video", server_name="envato",
                           input={"searchTerms": query, "perPage": 5})


def mcp_result(id_="m1", content="[{\"title\": \"City at night\", \"item_url\": \"https://elements.envato.com/x\"}]",
               is_error=False):
    return SimpleNamespace(type="mcp_tool_result", tool_use_id=id_, content=content, is_error=is_error)


def api_error(status, message):
    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    body = {"type": "error", "error": {"type": "invalid_request_error", "message": message}}
    cls = {400: anthropic.BadRequestError, 500: anthropic.InternalServerError}[status]
    return cls(message, response=httpx.Response(status, request=req, json=body), body=body)


MCP_DOWN = "Connection error while communicating with MCP server 'envato'"


def runs_with(fake):
    return agent.Runs(make_client=lambda: fake)


# ── the request ────────────────────────────────────────────────────

def test_envato_rides_along_with_only_its_search_tools_allowlisted():
    fake = FakeClient(reply(text("plan")))
    runs_with(fake).start("mark B-roll spots", SELECTION, SEQUENCE)
    kw = fake.calls[0]
    assert kw["betas"] == ["server-side-fallback-2026-07-01", "mcp-client-2025-11-20"]
    assert kw["mcp_servers"] == [{"type": "url", "url": "https://mcp.envato.com/mcp", "name": "envato"}]
    assert kw["tools"][:-1] == agent.TOOLS  # the panel's tools unchanged, the toolset last
    toolset = kw["tools"][-1]
    assert toolset["type"] == "mcp_toolset" and toolset["mcp_server_name"] == "envato"
    assert toolset["default_config"] == {"enabled": False}
    assert toolset["configs"] == {"search_stock_video": {"enabled": True}, "search_photos": {"enabled": True}}
    assert kw["system"] == agent.SYSTEM
    assert agent.TOOLS[-1]["name"] == "propose_filler_cuts"  # the module-level list was not changed


@pytest.mark.parametrize("value", ["0", "false", "off"])
def test_genius_cut_envato_0_turns_envato_off_and_tells_claude(monkeypatch, value):
    monkeypatch.setenv("GENIUSCUT_ENVATO", value)
    fake = FakeClient(reply(text("plan")))
    runs_with(fake).start("mark B-roll spots", SELECTION, SEQUENCE)
    kw = fake.calls[0]
    assert kw["betas"] == [claude.FALLBACK_BETA] and "mcp_servers" not in kw
    assert kw["tools"] == agent.TOOLS
    assert kw["system"].startswith(agent.SYSTEM) and agent.ENVATO_OFF in kw["system"]


def test_vertex_never_gets_the_envato_server(monkeypatch):
    monkeypatch.setenv("GENIUSCUT_LLM_PROVIDER", "vertex")
    calls = []

    class Stream:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get_final_message(self):
            return reply(text("plan"))

    def stream(**kw):
        calls.append(kw)
        return Stream()

    fake = SimpleNamespace(messages=SimpleNamespace(stream=stream))
    runs_with(fake).start("mark B-roll spots", SELECTION, SEQUENCE)
    assert "mcp_servers" not in calls[0] and "betas" not in calls[0]
    assert calls[0]["tools"] == agent.TOOLS and agent.ENVATO_OFF in calls[0]["system"]


# ── server-side MCP blocks ─────────────────────────────────────────

def test_envato_blocks_are_not_handed_to_the_panel_and_are_appended_whole():
    blocks = [thinking(), mcp_use(), mcp_result(), text("1. 0:12-0:18 B-roll: city skyline")]
    fake = FakeClient(reply(*blocks, stop="end_turn"))
    runs = runs_with(fake)
    r = runs.start("mark B-roll spots", SELECTION, SEQUENCE)
    assert r["state"] == "plan" and r["tool_calls"] == []
    assert r["text"] == "1. 0:12-0:18 B-roll: city skyline"
    run = runs._runs[r["run_id"]]
    assert run.messages[-1]["content"] == blocks and run.waiting == []


def test_only_client_tool_calls_go_to_the_panel_next_to_envato_blocks():
    fake = FakeClient(reply(mcp_use(), mcp_result(), tool("t1", "get_transcript", {"clipIds": ["V1@0#a"]}),
                            stop="tool_use"))
    runs = runs_with(fake)
    r = runs.start("mark B-roll spots", SELECTION, SEQUENCE)
    assert r["state"] == "tool_calls"
    assert r["tool_calls"] == [{"id": "t1", "name": "get_transcript", "input": {"clipIds": ["V1@0#a"]}}]
    assert runs._runs[r["run_id"]].waiting == ["t1"]


def test_a_paused_turn_is_appended_unchanged_and_continued():
    paused = [mcp_use(), mcp_result()]
    fake = FakeClient(reply(*paused, stop="pause_turn"), reply(text("the plan")))
    runs = runs_with(fake)
    r = runs.start("mark B-roll spots", SELECTION, SEQUENCE)
    assert r["state"] == "plan" and r["text"] == "the plan" and len(fake.calls) == 2
    second = fake.calls[1]["messages"]
    assert [m["role"] for m in second] == ["user", "assistant"] and second[1]["content"] == paused
    assert runs._runs[r["run_id"]].steps == 2


# ── Envato down ────────────────────────────────────────────────────

def test_an_mcp_connection_error_retries_once_without_envato_for_the_rest_of_the_run():
    fake = FakeClient(api_error(400, MCP_DOWN), reply(tool("t1", "get_sequence"), stop="tool_use"),
                      reply(text("plan with search terms only")))
    runs = runs_with(fake)
    r = runs.start("mark B-roll spots", SELECTION, SEQUENCE)
    assert r["state"] == "tool_calls" and len(fake.calls) == 2
    retry = fake.calls[1]
    assert "mcp_servers" not in retry and retry["betas"] == [claude.FALLBACK_BETA] and retry["tools"] == agent.TOOLS
    assert agent.ENVATO_DOWN in retry["system"]
    assert retry["messages"] == fake.calls[0]["messages"]  # the same step, nothing appended
    r = runs.results(r["run_id"], [{"tool_use_id": "t1", "content": "{}", "is_error": False}])
    assert r["state"] == "plan"
    assert "mcp_servers" not in fake.calls[2] and agent.ENVATO_DOWN in fake.calls[2]["system"]


def test_the_retry_happens_only_once():
    fake = FakeClient(api_error(400, MCP_DOWN), api_error(400, "MCP server unreachable"))
    r = runs_with(fake).start("mark B-roll spots", SELECTION, SEQUENCE)
    assert r["state"] == "stopped" and r["reason"] == "error" and len(fake.calls) == 2


def test_other_api_errors_are_not_retried():
    fake = FakeClient(api_error(400, "messages: text content blocks must be non-empty"))
    r = runs_with(fake).start("mark B-roll spots", SELECTION, SEQUENCE)
    assert r["state"] == "stopped" and r["reason"] == "error" and len(fake.calls) == 1
    assert "non-empty" in r["message"]


def test_an_mcp_error_with_envato_off_is_an_ordinary_error(monkeypatch):
    monkeypatch.setenv("GENIUSCUT_ENVATO", "0")
    fake = FakeClient(api_error(400, MCP_DOWN))
    r = runs_with(fake).start("mark B-roll spots", SELECTION, SEQUENCE)
    assert r["state"] == "stopped" and r["reason"] == "error" and len(fake.calls) == 1


# ── spend ──────────────────────────────────────────────────────────

def test_spend_is_recorded_when_usage_reports_server_tool_use():
    u = usage(inp=2000, out=1000, cw=100, cr=400)
    u.server_tool_use = SimpleNamespace(web_search_requests=0, web_fetch_requests=0)
    fake = FakeClient(reply(mcp_use(), mcp_result(), text("plan"), u=u))
    r = runs_with(fake).start("mark B-roll spots", SELECTION, SEQUENCE)
    rows = ledger()
    assert len(rows) == 1 and rows[0]["model"] == "claude-opus-5-5"
    expected = spend.cost_usd("claude-opus-5-5", 2000, 1000, cache_write=100, cache_read=400)
    assert rows[0]["usd"] == pytest.approx(expected)
    assert r["cost"]["usd"] == pytest.approx(expected) and r["cost"]["input_tokens"] == 2500


# ── the prompt ─────────────────────────────────────────────────────

def test_the_system_prompt_explains_b_roll_markers():
    s = " ".join(agent.SYSTEM.split())
    assert "B-roll" in s and "search_stock_video" in s and "add_markers" in s
    assert 'name "B-roll: <short idea>"' in s
    assert f"colour {agent.BROLL_COLOUR}" in s
    assert "horizontal" in s and "Stock Footage" in s
    assert "item_url" in s
    assert "never download" in s.lower()
    assert 0 <= agent.BROLL_COLOUR <= 7


def test_the_envato_notes_say_to_give_search_terms_only():
    for note in (agent.ENVATO_OFF, agent.ENVATO_DOWN):
        assert "search terms" in note and "B-roll" in note
