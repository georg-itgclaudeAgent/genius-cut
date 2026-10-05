"""The provider switch in front of Gemini and Claude."""

import pytest

from geniuscut import claude, gemini, llm


def test_default_provider_is_gemini():
    assert llm.provider() == "gemini"


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
    assert calls[0] == (target, ("p", {"type": "object"}),
                        {"system": "s", "client": "c", "effort": "low", "max_tokens": 5})
    assert calls[1][0] == target


def test_vertex_via_the_new_variable_reaches_claude_on_vertex(monkeypatch):
    monkeypatch.setenv("GENIUSCUT_LLM_PROVIDER", "vertex")
    assert claude.provider() == "vertex"


def test_model_follows_the_provider(monkeypatch):
    assert llm.model() == "gemini-3.7-flash"
    monkeypatch.setenv("GENIUSCUT_GEMINI_MODEL", "gemini-2.5-flash")
    assert llm.model() == "gemini-2.5-flash"
    monkeypatch.setenv("GENIUSCUT_LLM_PROVIDER", "anthropic")
    assert llm.model() == claude.MODEL
