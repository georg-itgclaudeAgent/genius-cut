"""One place that talks to Claude.

- Model `claude-opus-5-5` (override with GENIUSCUT_CLAUDE_MODEL).
- JSON comes back through structured outputs (`output_config.format`). Forced
  `tool_choice` returns a 400 on this model.
- Effort is always set explicitly; this model's default is `medium`.
- Server-side refusal fallback is on (`fallbacks="default"`), so a policy decline is
  retried on a fallback model inside the same call.
- A refusal or a truncated reply raises instead of being silently parsed.
"""

import json
import os

from geniuscut import secrets

MODEL = os.environ.get("GENIUSCUT_CLAUDE_MODEL", "claude-opus-5-5")
FALLBACK_BETA = "server-side-fallback-2026-07-01"


class ClaudeError(RuntimeError):
    pass


def default_client():
    import anthropic

    return anthropic.Anthropic(api_key=secrets.anthropic_api_key())


def _call(prompt: str, *, system: str | None, client, output_config: dict, max_tokens: int):
    client = client or default_client()
    kwargs = dict(
        model=MODEL,
        max_tokens=max_tokens,
        betas=[FALLBACK_BETA],
        fallbacks="default",
        output_config=output_config,
        messages=[{"role": "user", "content": prompt}],
    )
    if system:
        kwargs["system"] = system
    response = client.beta.messages.create(**kwargs)
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
