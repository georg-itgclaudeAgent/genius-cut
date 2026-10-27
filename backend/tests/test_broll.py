"""B-roll markers with Envato search (model picker plan Task 4): search_envato is a backend tool on every
provider; the backend runs every search of a reply in that step, the panel never sees them, and a run still
works when Envato is off (GENIUSCUT_ENVATO=0) or down. The Anthropic MCP connector is gone."""

import threading

import pytest

from geniuscut import agent, claude, envato
from tests.test_agent import SELECTION, SEQUENCE, FakeClient, reply, text, tool
from tests.test_envato import ITEMS, FakeMCP


class FakeSearch:
    """Runs.envato_search stand-in: records (kind, terms, orientation); `fail` raises EnvatoError."""

    def __init__(self, fail=False, found=None):
        self.fail, self.found, self.calls = fail, found, []
        self.lock = threading.Lock()

    def __call__(self, kind, terms, orientation=None):
        with self.lock:
            self.calls.append((kind, terms, orientation))
        if self.fail:
            raise envato.EnvatoError("couldn't reach the Envato server (timed out)")
        return self.found if self.found is not None else [
            {"title": f"{terms} clip", "author": "someone", "item_url": f"https://elements.envato.com/{len(terms)}"}]


def srch(id_, terms, kind="stock-video", orientation="horizontal"):
    inp = {"searchTerms": terms, "kind": kind, **({"orientation": orientation} if orientation else {})}
    return tool(id_, "search_envato", inp)


def runs_with(fake, search=None):
    return agent.Runs(make_client=lambda: fake, envato_search=search or FakeSearch())


def results_of(fake, call):
    return fake.calls[call]["messages"][-1]["content"]


@pytest.fixture
def mcp():
    s = FakeMCP(mode="sse")
    yield s
    s.close()


# ── the tool on every provider ─────────────────────────────────────

def test_search_envato_is_an_ordinary_backend_tool_and_no_mcp_connector_is_sent():
    fake = FakeClient(reply(text("plan")))
    runs_with(fake).start("mark B-roll spots", SELECTION, SEQUENCE)
    kw = fake.calls[0]
    assert kw["betas"] == [claude.FALLBACK_BETA] and "mcp_servers" not in kw
    assert kw["tools"] == agent.TOOLS and kw["system"] == agent.SYSTEM
    assert agent.TOOL_KINDS["search_envato"] == "backend"
    for gone in ("ENVATO_TOOLSET", "ENVATO_SERVER", "MCP_BETA", "EnvatoUnavailable", "envato_enabled"):
        assert not hasattr(claude, gone)


def test_the_tool_schema():
    schema = next(t for t in agent.TOOLS if t["name"] == "search_envato")["input_schema"]
    assert schema["required"] == ["searchTerms", "kind"] and schema["additionalProperties"] is False
    terms = schema["properties"]["searchTerms"]
    assert (terms["type"], terms["minLength"], terms["maxLength"]) == ("string", 1, 60)
    assert schema["properties"]["kind"]["enum"] == ["stock-video", "photos"]
    assert schema["properties"]["orientation"]["enum"] == ["horizontal", "vertical"]


@pytest.mark.parametrize("value", ["0", "false", "off"])
def test_genius_cut_envato_0_removes_the_tool_and_tells_the_model(monkeypatch, value):
    monkeypatch.setenv("GENIUSCUT_ENVATO", value)
    fake = FakeClient(reply(text("plan")))
    runs_with(fake).start("mark B-roll spots", SELECTION, SEQUENCE)
    kw = fake.calls[0]
    assert "search_envato" not in [t["name"] for t in kw["tools"]]
    assert kw["tools"] == [t for t in agent.TOOLS if t["name"] != "search_envato"]
    assert kw["system"].startswith(agent.SYSTEM) and agent.ENVATO_OFF in kw["system"]


def test_vertex_gets_the_tool_too(monkeypatch):
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

    from types import SimpleNamespace
    fake = SimpleNamespace(messages=SimpleNamespace(stream=stream))
    runs_with(fake).start("mark B-roll spots", SELECTION, SEQUENCE)
    assert "mcp_servers" not in calls[0] and "betas" not in calls[0]
    assert calls[0]["tools"] == agent.TOOLS and calls[0]["system"] == agent.SYSTEM


# ── batched searches ───────────────────────────────────────────────

def test_every_search_of_a_reply_runs_in_that_step_through_the_mcp_server(mcp):
    fake = FakeClient(reply(srch("s1", "typing on laptop"), srch("s2", "city skyline night"),
                            srch("s3", "office desk", kind="photos", orientation=None), stop="tool_use"),
                      reply(text("1. 0:12-0:18 B-roll: typing")))
    runs = runs_with(fake, search=mcp.search)
    r = runs.start("mark B-roll spots", SELECTION, SEQUENCE)
    assert r["state"] == "plan" and r["tool_calls"] == [] and len(fake.calls) == 2
    assert runs._runs[r["run_id"]].steps == 2
    calls = [q["body"]["params"] for q in mcp.requests if q["method"] == "tools/call"]
    assert sorted((c["name"], c["arguments"]["searchTerms"]) for c in calls) == [
        ("search_photos", "office desk"), ("search_stock_video", "city skyline night"),
        ("search_stock_video", "typing on laptop")]
    back = results_of(fake, 1)
    assert [b["tool_use_id"] for b in back] == ["s1", "s2", "s3"]  # one turn, the reply's order
    assert not any(b["is_error"] for b in back)
    assert ITEMS[0]["title"] in back[0]["content"] and ITEMS[0]["item_url"] in back[0]["content"]
    assert 'Envato results for "typing on laptop":' in back[0]["content"]


def test_searches_run_side_by_side():
    started = threading.Barrier(3, timeout=5)

    def search(kind, terms, orientation=None):
        started.wait()  # all three must be running at once to get past this
        return [{"title": terms, "item_url": "https://elements.envato.com/x"}]

    fake = FakeClient(reply(srch("s1", "a"), srch("s2", "b"), srch("s3", "c"), stop="tool_use"), reply(text("plan")))
    r = runs_with(fake, search=search).start("mark B-roll spots", SELECTION, SEQUENCE)
    assert r["state"] == "plan" and [b["is_error"] for b in results_of(fake, 1)] == [False] * 3


def test_searches_next_to_panel_tools_wait_for_the_panel_and_go_back_in_order():
    search = FakeSearch()
    fake = FakeClient(reply(srch("s1", "city"), tool("t1", "get_transcript", {"clipIds": ["V1@0#a"]}),
                            srch("s2", "laptop"), stop="tool_use"), reply(text("plan")))
    runs = runs_with(fake, search)
    r = runs.start("mark B-roll spots", SELECTION, SEQUENCE)
    assert r["state"] == "tool_calls"
    assert r["tool_calls"] == [{"id": "t1", "name": "get_transcript", "input": {"clipIds": ["V1@0#a"]}}]
    assert len(search.calls) == 2  # already ran, in this step
    r = runs.results(r["run_id"], [{"tool_use_id": "t1", "content": "words", "is_error": False}])
    assert r["state"] == "plan"
    assert [b["tool_use_id"] for b in results_of(fake, 1)] == ["s1", "t1", "s2"]


def test_no_results_is_not_an_error():
    fake = FakeClient(reply(srch("s1", "zzz"), stop="tool_use"), reply(text("plan")))
    runs_with(fake, FakeSearch(found=[])).start("mark B-roll spots", SELECTION, SEQUENCE)
    b = results_of(fake, 1)[0]
    assert not b["is_error"] and "No Envato results" in b["content"]


def test_bad_input_is_an_error_result_without_the_down_flag():
    search = FakeSearch()
    fake = FakeClient(reply(srch("s1", "x" * 61), srch("s2", "ok", kind="music"), stop="tool_use"),
                      reply(text("plan")))
    runs = runs_with(fake, search)
    r = runs.start("mark B-roll spots", SELECTION, SEQUENCE)
    back = results_of(fake, 1)
    assert [b["is_error"] for b in back] == [True, True] and "searchTerms" in back[0]["content"]
    assert search.calls == [] and agent.ENVATO_DOWN not in fake.calls[1]["system"]


def test_backend_only_search_steps_count_toward_the_cap():
    fake = FakeClient(*[reply(srch(f"s{i}", "city"), stop="tool_use") for i in range(45)])
    r = runs_with(fake).start("mark B-roll spots", SELECTION, SEQUENCE)
    assert r["state"] == "stopped" and r["reason"] == "step_cap" and len(fake.calls) == agent.MAX_STEPS == 40


# ── Envato down ────────────────────────────────────────────────────

def test_a_failed_search_is_an_error_result_and_sets_the_down_flag(mcp):
    mcp.fail = "http"
    fake = FakeClient(reply(srch("s1", "city"), stop="tool_use"), reply(srch("s2", "laptop"), stop="tool_use"),
                      reply(text("plan with search terms only")))
    runs = runs_with(fake, search=mcp.search)
    r = runs.start("mark B-roll spots", SELECTION, SEQUENCE)
    assert r["state"] == "plan"
    first = results_of(fake, 1)[0]
    assert first["is_error"] and "HTTP 500" in first["content"] and "search terms only" in first["content"]
    run = runs._runs[r["run_id"]]
    assert run.envato_down and run.envato_note == agent.ENVATO_DOWN
    assert agent.ENVATO_DOWN not in fake.calls[0]["system"] and agent.ENVATO_DOWN in fake.calls[1]["system"]
    assert agent.ENVATO_DOWN in fake.calls[2]["system"]
    second = results_of(fake, 2)[0]
    assert second["is_error"] and "earlier in this run" in second["content"]
    assert [q["method"] for q in mcp.requests].count("tools/call") == 1  # no second try at a down server


def test_an_unexpected_search_crash_is_envato_down_not_a_crashed_run():
    def boom(*a):
        raise RuntimeError("bug")

    fake = FakeClient(reply(srch("s1", "city"), stop="tool_use"), reply(text("plan")))
    r = runs_with(fake, search=boom).start("mark B-roll spots", SELECTION, SEQUENCE)
    assert r["state"] == "plan" and results_of(fake, 1)[0]["is_error"]
    assert agent.ENVATO_DOWN in fake.calls[1]["system"]


def test_a_pause_turn_is_an_error_now_that_no_server_tools_are_sent():
    fake = FakeClient(reply(text("half"), stop="pause_turn"))
    runs = runs_with(fake)
    r = runs.start("mark B-roll spots", SELECTION, SEQUENCE)
    assert r["state"] == "stopped" and r["reason"] == "error" and len(fake.calls) == 1


# ── the prompt ─────────────────────────────────────────────────────

def test_the_system_prompt_explains_b_roll_markers_with_the_tool():
    s = " ".join(agent.SYSTEM.split())
    assert "B-roll" in s and "search_envato" in s and "add_markers" in s
    assert "search_stock_video" not in s and "Anthropic runs" not in s
    assert "ONE reply" in s and "side by side" in s  # batch every search into one reply
    assert 'name "B-roll: <short idea>"' in s
    assert f"colour {agent.BROLL_COLOUR}" in s
    assert "horizontal" in s and "stock-video" in s
    assert "item_url" in s
    assert "never download" in s.lower()
    assert 0 <= agent.BROLL_COLOUR <= 7


def test_the_envato_notes_say_to_give_search_terms_only():
    for note in (agent.ENVATO_OFF, agent.ENVATO_DOWN, agent.ENVATO_FAILED):
        assert "search terms" in note and "B-roll" in note
