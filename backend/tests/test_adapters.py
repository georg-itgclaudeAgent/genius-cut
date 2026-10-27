"""The provider-neutral agent loop (model picker plan Task 2): adapters, Claude on Anthropic or Vertex, a run
keeps its model after a switch (Gemini: test_gemini_adapter.py)."""

from types import SimpleNamespace

import pytest

from geniuscut import adapters, agent, catalog, settings
from tests.test_agent import SELECTION, SEQUENCE, FakeClient, reply, text, thinking, tool


def select(model_id):
    s = settings.load()
    s.model = model_id
    settings.save(s)


class Stream:
    def __init__(self, response):
        self.response = response

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get_final_message(self):
        return self.response


class BothClient:
    """Records which API a step used: `plain` (client.messages.stream, Vertex) or `beta` (Anthropic API)."""

    def __init__(self, *replies):
        self.replies, self.calls = list(replies), []

        def stream(kind):
            def f(**kw):
                self.calls.append((kind, {**kw, "messages": list(kw["messages"])}))
                return Stream(self.replies.pop(0))
            return f

        self.messages = SimpleNamespace(stream=stream("plain"))
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=stream("beta")))


# ── Vertex request shape ───────────────────────────────────────────

def test_a_vertex_run_sends_only_what_vertex_takes():
    select("vertex:claude-opus-5-5")
    fake = BothClient(reply(tool("t1", "get_sequence"), stop="tool_use"))
    r = agent.Runs(make_client=lambda: fake).start("x", SELECTION, SEQUENCE)
    assert r["state"] == "tool_calls"
    kind, kw = fake.calls[0]
    assert kind == "plain"
    assert kw["model"] == "claude-opus-5-5" and kw["max_tokens"] == 32000  # bare id, the catalog's max output
    assert kw["tool_choice"] == {"type": "auto"} and kw["tools"] == agent.TOOLS
    for k in ("betas", "fallbacks", "mcp_servers", "output_config", "cache_control", "thinking"):
        assert k not in kw
    assert kw["system"] == agent.SYSTEM  # search_envato is offered on Vertex too (a backend tool)
    assert "search_envato" in [t["name"] for t in kw["tools"]]
    assert (r["cost"]["model"], r["cost"]["provider"]) == ("vertex:claude-opus-5-5", "vertex")
    assert r["cost"]["label"] == "Claude Opus 5.5 (Google Cloud)"


def test_the_vertex_client_uses_the_settings_project_and_region(monkeypatch):
    s = settings.load()
    s.vertex = settings.VertexSettings(project="my-gcp-proj", region="us-east5")
    settings.save(s)
    made = {}
    monkeypatch.setattr(adapters.claude.anthropic, "AnthropicVertex", lambda **kw: made.update(kw) or "client")
    monkeypatch.setattr(adapters.claude.secrets, "anthropic_api_key", lambda: pytest.fail("no API key on Vertex"))
    assert adapters.for_entry(catalog.get("vertex:claude-sonnet-5-5")).make_client() == "client"
    assert made == {"project_id": "my-gcp-proj", "region": "us-east5"}


def test_a_model_without_fallbacks_gets_none_on_the_anthropic_api():
    select("anthropic:claude-haiku-5-5")
    fake = FakeClient(reply(text("plan")))
    agent.Runs(make_client=lambda: fake).start("x", SELECTION, SEQUENCE)
    kw = fake.calls[0]
    assert kw["model"] == "claude-haiku-5-5" and "fallbacks" not in kw
    assert "betas" not in kw and "mcp_servers" not in kw  # no fallbacks beta, no MCP connector
    assert kw["output_config"] == {"effort": "high"} and kw["cache_control"] == {"type": "ephemeral"}


# ── runs keep their model ──────────────────────────────────────────

def test_a_run_keeps_its_model_after_a_switch_and_the_next_run_takes_the_new_one():
    select("anthropic:claude-opus-5-5")
    fake = BothClient(reply(tool("t1", "get_sequence"), stop="tool_use"), reply(text("plan")),
                      reply(text("vertex plan"), model="claude-sonnet-5-5"))
    made = []
    runs = agent.Runs(make_client=lambda: made.append(1) or fake)
    first = runs.start("x", SELECTION, SEQUENCE)
    select("vertex:claude-sonnet-5-5")  # the picker changes while the run waits for tool results
    body = runs.results(first["run_id"], [{"tool_use_id": "t1", "content": "ok", "is_error": False}])
    assert body["state"] == "plan" and body["cost"]["model"] == "anthropic:claude-opus-5-5"
    assert [k for k, _ in fake.calls] == ["beta", "beta"]
    assert all(kw["model"] == "claude-opus-5-5" and kw["fallbacks"] == "default" for _, kw in fake.calls)
    second = runs.start("y", SELECTION, SEQUENCE)
    assert fake.calls[2][0] == "plain" and fake.calls[2][1]["model"] == "claude-sonnet-5-5"
    assert second["cost"]["model"] == "vertex:claude-sonnet-5-5"
    assert len(made) == 2  # one client per run


def test_the_run_resolves_the_selection_once():
    seen = []
    fake = FakeClient(reply(tool("t1", "get_sequence"), stop="tool_use"), reply(text("plan")))
    runs = agent.Runs(make_client=lambda: fake, selected=lambda: seen.append(1) or "anthropic:claude-opus-5-5")
    first = runs.start("x", SELECTION, SEQUENCE)
    runs.results(first["run_id"], [{"tool_use_id": "t1", "content": "ok", "is_error": False}])
    assert seen == [1]


# ── the adapter owns the history ───────────────────────────────────

def test_the_claude_adapter_appends_turns_whole_and_maps_ids_to_names():
    a = adapters.for_entry(catalog.get("anthropic:claude-opus-5-5"))
    assert isinstance(a, adapters.ClaudeAdapter)
    a.add_user_text("hi")
    content = [thinking(), text("Reading."), tool("t1", "get_sequence"), tool("t2", "read_graphic", {"slug": "s"})]
    fake = FakeClient(reply(*content, stop="tool_use"))
    step = a.step("sys", agent.TOOLS, client=fake, input_tokens=100)
    assert step.stop == "tool_use" and step.text == "Reading." and step.requests == 1
    assert step.tool_calls == [{"id": "t1", "name": "get_sequence", "input": {}},
                               {"id": "t2", "name": "read_graphic", "input": {"slug": "s"}}]
    assert step.model == "anthropic:claude-opus-5-5"
    assert step.usage == adapters.Usage(1000, 500)
    assert a.history[-1]["role"] == "assistant" and a.history[-1]["content"] == content  # whole, thinking incl.
    assert a.names == {"t1": "get_sequence", "t2": "read_graphic"}
    a.add_tool_results([adapters.ToolResult("t1", "seq"), adapters.ToolResult("t2", "boom", True)])
    assert a.history[-1] == {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "t1", "content": "seq", "is_error": False},
        {"type": "tool_result", "tool_use_id": "t2", "content": "boom", "is_error": True}]}


def test_usage_is_normalised_with_cache_tokens_in_the_input():
    from tests.test_agent import usage
    a = adapters.for_entry(catalog.get("anthropic:claude-opus-5-5"))
    a.add_user_text("hi")
    step = a.step("sys", [], client=FakeClient(reply(text("ok"), u=usage(10, 5, cw=20, cr=300))), input_tokens=10)
    assert step.usage == adapters.Usage(330, 5) and step.stop == "end"


@pytest.mark.parametrize("stop", ["refusal", "max_tokens"])
def test_refused_and_cut_off_replies_are_not_appended(stop):
    a = adapters.for_entry(catalog.get("anthropic:claude-opus-5-5"))
    a.add_user_text("hi")
    details = SimpleNamespace(category="cyber") if stop == "refusal" else None
    step = a.step("sys", [], client=FakeClient(reply(tool("t1", "cut_ranges"), stop=stop, details=details)),
                  input_tokens=10)
    assert step.stop == stop and step.tool_calls == [] and len(a.history) == 1
    assert step.detail == ("cyber" if stop == "refusal" else None)


def test_the_refusal_message_names_the_model_by_its_label():
    fake = FakeClient(reply(text("no"), stop="refusal", details=SimpleNamespace(category="cyber")))
    r = agent.Runs(make_client=lambda: fake).start("x", SELECTION, SEQUENCE)
    assert r["reason"] == "refusal" and r["message"] == "Claude Opus 5.5 (Anthropic) declined this instruction (cyber)."
