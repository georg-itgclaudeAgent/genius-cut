import pytest

# Settings that change which AI provider, model or limit a test sees, or where the spend
# ledger lands. Cleared so the developer's own environment can't leak into a test.
_AI_ENV = ["GENIUSCUT_LLM_PROVIDER", "GENIUSCUT_CLAUDE_PROVIDER", "GENIUSCUT_GEMINI_MODEL",
           "GENIUSCUT_GEMINI_API_KEY", "GENIUSCUT_GEMINI_THINKING", "GENIUSCUT_MONTHLY_LIMIT_USD"]


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path, monkeypatch):
    """Every test gets its own data dir, so nothing writes to the real %APPDATA% ledger."""
    monkeypatch.setenv("GENIUSCUT_DATA_DIR", str(tmp_path / "data"))
    for name in _AI_ENV:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    """A test that forgets to inject a transport fails here instead of making a paid call."""
    import urllib.request

    def refuse(*args, **kwargs):
        raise AssertionError("tests must not make real HTTP calls; inject a transport")

    monkeypatch.setattr(urllib.request, "urlopen", refuse)
