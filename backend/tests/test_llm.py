"""The provider switch in front of Gemini and Claude."""

import pytest

from geniuscut import catalog, claude, gemini, llm, settings


def test_default_provider_is_claude_on_the_anthropic_api():
    assert llm.provider() == "anthropic"


def test_llm_provider_variable(monkeypatch):
    monkeypatch.setenv("GENIUSCUT_LLM_PROVIDER", " Vertex ")
    assert llm.provider() == "vertex"


def test_falls_back_to_the_old_claude_provider_variable(monkeypatch):
    monkeypatch.setenv("GENIUSCUT_CLAUDE_PROVIDER", "anthropic")
    assert llm.provider() == "anthropic"
    monkeypatch.setenv("GENIUSCUT_LLM_PROVIDER", "gemini")
    assert llm.provider() == "gemini"


def test_unknown_provider_names_the_variable_and_the_valid_values(monkeypatch):
    monkeypatch.setenv("GENIUSCUT_LLM_PROVIDER", "bedrock")
    with pytest.raises(llm.LLMError) as e:
        llm.provider()
    assert "GENIUSCUT_LLM_PROVIDER" in str(e.value)
    assert all(v in str(e.value) for v in ("gemini", "anthropic", "vertex"))


def test_unknown_value_in_the_fallback_variable_names_that_variable(monkeypatch):
    monkeypatch.setenv("GENIUSCUT_CLAUDE_PROVIDER", "bedrock")
    with pytest.raises(llm.LLMError, match="GENIUSCUT_CLAUDE_PROVIDER"):
        llm.provider()


def test_claude_error_is_an_llm_error():
    assert issubclass(claude.ClaudeError, llm.LLMError)


def _spy(calls, name, result):
    def f(*args, **kwargs):
        calls.append((name, args, kwargs))
        return result
    return f


@pytest.mark.parametrize("provider, target", [("gemini", "gemini"), ("anthropic", "claude"), ("vertex", "claude")])
def test_dispatch(monkeypatch, provider, target):
    monkeypatch.setenv("GENIUSCUT_LLM_PROVIDER", provider)
    calls = []
    for mod, name in ((gemini, "gemini"), (claude, "claude")):
        monkeypatch.setattr(mod, "ask_json", _spy(calls, name, {"ok": name}))
        monkeypatch.setattr(mod, "ask_text", _spy(calls, name, name))
    assert llm.ask_json("p", {"type": "object"}, system="s", client="c", effort="low", max_tokens=5) == {"ok": target}
    assert llm.ask_text("p") == target
    which = ({"model": "gemini-3.7-flash"} if target == "gemini"
             else {"entry": catalog.get(f"{provider}:claude-opus-5-5")})
    assert calls[0] == (target, ("p", {"type": "object"}),
                        {"system": "s", "client": "c", "effort": "low", "max_tokens": 5, **which})
    assert calls[1][0] == target


def test_vertex_via_the_new_variable_reaches_claude_on_vertex(monkeypatch):
    monkeypatch.setenv("GENIUSCUT_LLM_PROVIDER", "vertex")
    assert claude.provider() == "vertex"


def test_model_follows_the_provider(monkeypatch):
    assert llm.model() == claude.MODEL == "claude-opus-5-5"
    monkeypatch.setenv("GENIUSCUT_LLM_PROVIDER", "gemini")
    assert llm.model() == "gemini-3.7-flash"
    monkeypatch.setenv("GENIUSCUT_GEMINI_MODEL", "gemini-2.5-flash")
    assert llm.model() == "gemini-2.5-flash"
    monkeypatch.setenv("GENIUSCUT_LLM_PROVIDER", "anthropic")
    assert llm.model() == claude.MODEL


# ── routing by the picker's selection (plan Task 2) ──────────────────

def _select(model_id):
    s = settings.load()
    s.model = model_id
    settings.save(s)


def _fake_claude(calls, payload):
    from types import SimpleNamespace
    resp = SimpleNamespace(stop_reason="end_turn", stop_details=None, model=None, usage=None,
                           content=[SimpleNamespace(type="text", text=payload)])

    def create(kind):
        def f(**kw):
            calls.append((kind, kw))
            return resp
        return f
    return SimpleNamespace(messages=SimpleNamespace(create=create("plain")),
                           beta=SimpleNamespace(messages=SimpleNamespace(create=create("beta"))))


def test_analyse_on_the_anthropic_selection_uses_the_beta_api_with_fallbacks_and_structured_output():
    _select("anthropic:claude-sonnet-5-5")
    calls = []
    assert llm.ask_json("p", {"type": "object"}, client=_fake_claude(calls, '{"ok": 1}')) == {"ok": 1}
    kind, kw = calls[0]
    assert kind == "beta" and kw["model"] == "claude-sonnet-5-5" and kw["fallbacks"] == "default"
    assert kw["output_config"]["format"] == {"type": "json_schema", "schema": {"type": "object"}}


def test_analyse_on_a_vertex_selection_uses_the_plain_api_without_unverified_params():
    _select("vertex:claude-haiku-5-5")
    calls = []
    fenced = '```json\n{"ok": 2}\n```'
    assert llm.ask_json("p", {"type": "object"}, client=_fake_claude(calls, fenced)) == {"ok": 2}
    kind, kw = calls[0]
    assert kind == "plain" and kw["model"] == "claude-haiku-5-5"
    for k in ("fallbacks", "betas", "output_config", "cache_control"):
        assert k not in kw
    assert '{"type": "object"}' in kw["messages"][0]["content"]  # the schema rides in the prompt


def test_analyse_on_a_gemini_selection_calls_that_gemini_model(monkeypatch):
    _select("gemini:gemini-3.8-flash")
    monkeypatch.setenv("GENIUSCUT_GEMINI_API_KEY", "AIza-test")
    seen = []

    def transport(url, body, headers):
        seen.append(url)
        return {"candidates": [{"content": {"parts": [{"text": '{"ok": 3}'}]}, "finishReason": "STOP"}],
                "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 2}}

    assert llm.ask_json("p", {"type": "object"}, client=transport) == {"ok": 3}
    assert seen[0].endswith("/gemini-3.8-flash:generateContent")


def test_a_dev_override_still_wins_over_the_selection(monkeypatch):
    _select("gemini:gemini-3.8-flash")
    monkeypatch.setenv("GENIUSCUT_LLM_PROVIDER", "anthropic")
    assert llm.selected_entry().id == "anthropic:claude-opus-5-5"


def test_using_pins_one_model_for_calls_inside_it():
    _select("anthropic:claude-opus-5-5")
    pinned = catalog.get("vertex:claude-opus-5-5")
    with llm.using(pinned):
        _select("gemini:gemini-3.8-flash")  # a switch mid-Analyse doesn't change the running one
        assert llm.current_entry() is pinned
    assert llm.current_entry().id == "gemini:gemini-3.8-flash"


def test_run_trim_resolves_the_selection_once_for_the_whole_proposal(tmp_path):
    from geniuscut import trim
    from tests.test_trim import REQ, FakeTranscriber, fake_extract
    _select("gemini:gemini-3.8-flash")
    seen = []

    def propose(words, fewshot, instruction):
        seen.append(llm.current_entry().id)
        _select("anthropic:claude-opus-5-5")  # a switch mid-Analyse
        seen.append(llm.current_entry().id)
        return []

    r = trim.run_trim(REQ, FakeTranscriber(), tmp_path, propose=propose, extract=fake_extract)
    assert seen == ["gemini:gemini-3.8-flash"] * 2
    assert (r.cost.model, r.cost.label) == ("gemini:gemini-3.8-flash", "Gemini 3.8 Flash")  # no call ran
