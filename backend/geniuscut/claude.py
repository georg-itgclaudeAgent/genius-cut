"""One place that talks to Claude.

- Model `claude-opus-5-5` (override with GENIUSCUT_CLAUDE_MODEL).
- Provider: the Anthropic API (default, key from env/GSM) or Google Cloud Vertex AI
  (GENIUSCUT_CLAUDE_PROVIDER=vertex; bills the GCP project, uses the gcloud login).
- JSON comes back through structured outputs (`output_config.format`). Forced
  `tool_choice` returns a 400 on this model.
- Effort is always set explicitly; this model's default is `medium`.
- On the Anthropic API, server-side refusal fallback is on (`fallbacks="default"`), so a
  policy decline is retried on a fallback model inside the same call. Vertex doesn't offer it.
- A refusal or a truncated reply raises instead of being silently parsed.
"""

import json
import os

import anthropic

from geniuscut import secrets

MODEL = os.environ.get("GENIUSCUT_CLAUDE_MODEL", "claude-opus-5-5")
FALLBACK_BETA = "server-side-fallback-2026-07-01"


class ClaudeError(RuntimeError):
    pass


def provider() -> str:
    return (os.environ.get("GENIUSCUT_CLAUDE_PROVIDER") or "anthropic").strip().lower()


def default_client():
    p = provider()
    if p == "anthropic":
        return anthropic.Anthropic(api_key=secrets.anthropic_api_key())
    if p == "vertex":
        # Bare model IDs on Vertex; auth is the machine's gcloud application-default login.
        return anthropic.AnthropicVertex(
            project_id=os.environ.get("GENIUSCUT_VERTEX_PROJECT", "agent-georg"),
            region=os.environ.get("GENIUSCUT_VERTEX_REGION", "global"),
        )
    raise ClaudeError(f"Unknown GENIUSCUT_CLAUDE_PROVIDER {p!r}: use 'anthropic' or 'vertex'.")


def _api_message(e) -> str:
    body = getattr(e, "body", None)
    if isinstance(body, dict):
        msg = (body.get("error") or {}).get("message")
        if msg:
            return msg
    return str(e)


def _call(prompt: str, *, system: str | None, client, output_config: dict, max_tokens: int):
    client = client or default_client()
    kwargs = dict(
        model=MODEL,
        max_tokens=max_tokens,
        output_config=output_config,
        messages=[{"role": "user", "content": prompt}],
    )
    if system:
        kwargs["system"] = system
    if provider() == "vertex":
        create = client.messages.create
    else:
        kwargs.update(betas=[FALLBACK_BETA], fallbacks="default")
        create = client.beta.messages.create
    try:
        response = create(**kwargs)
    except anthropic.AuthenticationError as e:
        raise ClaudeError(f"The Anthropic API key was rejected: {_api_message(e)}") from e
    except anthropic.RateLimitError as e:
        raise ClaudeError(f"Anthropic is rate-limiting requests; try again shortly. {_api_message(e)}") from e
    except anthropic.APIStatusError as e:
        raise ClaudeError(f"Anthropic API error {e.status_code}: {_api_message(e)}") from e
    except anthropic.APIConnectionError as e:
        raise ClaudeError("Couldn't reach the Anthropic API. Check the internet connection.") from e
    except Exception as e:
        if type(e).__module__.startswith("google.auth"):
            raise ClaudeError("No Google Cloud login for Vertex AI on this machine. "
                              "Run: gcloud auth application-default login") from e
        raise
    if response.stop_reason == "refusal":
        details = getattr(response, "stop_details", None)
        raise ClaudeError(f"Claude declined the request ({getattr(details, 'category', None) or 'no category'}).")
    if response.stop_reason == "max_tokens":
        raise ClaudeError("Claude's reply was cut off at max_tokens. Try a shorter clip.")
    text = "".join(b.text for b in response.content if getattr(b, "type", None) == "text")
    if not text.strip():
        raise ClaudeError("Claude returned no text.")
    return text


def ask_json(prompt: str, schema: dict, *, system: str | None = None, client=None,
             effort: str = "high", max_tokens: int = 16000) -> dict:
    text = _call(prompt, system=system, client=client, max_tokens=max_tokens,
                 output_config={"format": {"type": "json_schema", "schema": schema}, "effort": effort})
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise ClaudeError(f"Claude returned invalid JSON: {e}") from e


def ask_text(prompt: str, *, system: str | None = None, client=None,
             effort: str = "medium", max_tokens: int = 16000) -> str:
    return _call(prompt, system=system, client=client, max_tokens=max_tokens,
                 output_config={"effort": effort})
