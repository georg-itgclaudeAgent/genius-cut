"""Claude through Google Cloud Vertex AI (billing on the GCP account instead of an Anthropic key)."""

import json
from types import SimpleNamespace

import pytest

from geniuscut import claude


class FakeClient:
    """Stands in for AnthropicVertex: only the non-beta messages API."""

    def __init__(self, payload):
        self.requests = []
        resp = SimpleNamespace(stop_reason="end_turn", stop_details=None,
                               content=[SimpleNamespace(type="text", text=json.dumps(payload))])

        def create(**kw):
            self.requests.append(kw)
            return resp

        self.messages = SimpleNamespace(create=create)


def test_vertex_calls_the_plain_messages_api_without_api_only_params(monkeypatch):
    monkeypatch.setenv("GENIUSCUT_CLAUDE_PROVIDER", "vertex")
    fake = FakeClient({"ok": True})
    assert claude.ask_json("hi", {"type": "object"}, client=fake) == {"ok": True}
    req = fake.requests[0]
    assert req["model"] == "claude-opus-5-5"  # bare ID on Vertex, no prefix or @date
    assert req["output_config"]["format"]["type"] == "json_schema"
    assert "effort" in req["output_config"]
    # Server-side refusal fallback is Claude-API-only.
    assert "fallbacks" not in req and "betas" not in req


def test_vertex_client_uses_the_gcp_project_and_region(monkeypatch):
    monkeypatch.setenv("GENIUSCUT_CLAUDE_PROVIDER", "vertex")
    monkeypatch.delenv("GENIUSCUT_VERTEX_PROJECT", raising=False)
    monkeypatch.delenv("GENIUSCUT_VERTEX_REGION", raising=False)
    made = {}

    class FakeVertex:
        def __init__(self, **kw):
            made.update(kw)

    monkeypatch.setattr(claude.anthropic, "AnthropicVertex", FakeVertex)
    claude.default_client()
    assert made == {"project_id": "agent-georg", "region": "global"}


def test_vertex_needs_no_anthropic_api_key(monkeypatch):
    monkeypatch.setenv("GENIUSCUT_CLAUDE_PROVIDER", "vertex")
    monkeypatch.setattr(claude.anthropic, "AnthropicVertex", lambda **kw: object())
    monkeypatch.setattr(claude.secrets, "anthropic_api_key", lambda: pytest.fail("must not look up an API key"))
    claude.default_client()


def test_unknown_provider_is_a_clear_error(monkeypatch):
    monkeypatch.setenv("GENIUSCUT_CLAUDE_PROVIDER", "bedrock")
    with pytest.raises(claude.ClaudeError, match="GENIUSCUT_CLAUDE_PROVIDER"):
        claude.default_client()


def test_default_provider_is_still_the_anthropic_api(monkeypatch):
    monkeypatch.delenv("GENIUSCUT_CLAUDE_PROVIDER", raising=False)
    assert claude.provider() == "anthropic"


def test_missing_google_login_is_a_readable_error(monkeypatch):
    monkeypatch.setenv("GENIUSCUT_CLAUDE_PROVIDER", "vertex")
    DefaultCredentialsError = type("DefaultCredentialsError", (Exception,), {"__module__": "google.auth.exceptions"})

    def create(**kw):
        raise DefaultCredentialsError("Your default credentials were not found.")

    client = SimpleNamespace(messages=SimpleNamespace(create=create))
    with pytest.raises(claude.ClaudeError, match="gcloud auth application-default login"):
        claude.ask_json("hi", {}, client=client)
