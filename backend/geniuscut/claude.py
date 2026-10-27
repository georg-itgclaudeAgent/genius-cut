"""One place that talks to Claude for Analyse (ask_json / ask_text), plus the client and error code the
agent's ClaudeAdapter (adapters.py) shares.

- The model is a catalog entry (`catalog.Entry`), passed per call by `llm.py` from the panel's picker.
  Called without one, this module uses its own dev default, read per call: `<provider()>:<model()>`,
  i.e. GENIUSCUT_LLM_PROVIDER / GENIUSCUT_CLAUDE_PROVIDER (anthropic | vertex) and GENIUSCUT_CLAUDE_MODEL
  (default `claude-opus-5-5`).
- Provider: the Anthropic API (key from the editor's Secret Manager, `settings.json`) or Google Cloud Vertex
  AI (`AnthropicVertex`, the gcloud application-default login, project/region from `settings.vertex`;
  GENIUSCUT_VERTEX_PROJECT / GENIUSCUT_VERTEX_REGION are dev overrides). Bills the GCP project.
- The request carries only what the entry's `Params` allow: `output_config` (effort, JSON-schema format) only
  where `output_config` is on; with structured output off, the JSON schema goes in the prompt and the reply
  is parsed leniently (a ```json fence is stripped). Forced `tool_choice` returns a 400 on these models.
- Effort is set explicitly where allowed; Opus 5.5's default is `medium`. Thinking can't be turned off on
  Opus 5.5; it's billed as output, which `usage.output_tokens` includes.
- Server-side refusal fallback (`fallbacks="default"`) only on the Anthropic API and only for models whose
  params say so (catalog). Vertex never gets it.
- A refusal or a truncated reply raises instead of being silently parsed.
- Before every call the spend gate checks the worst case against the monthly limit, so a refused run never
  reaches the API; an unpriced model is refused. Usage is recorded in the spend ledger after every reply
  under the catalog id of the model that answered, priced as the id asked for when that one has no price.
  An API error also updates the model picker's cached state (catalog.observe), e.g. the workspace cap.
"""

import json
import os
import re
import subprocess
from contextlib import contextmanager

import anthropic

from geniuscut import catalog, secrets, spend
from geniuscut.errors import LLMError

MODEL = "claude-opus-5-5"  # the dev default; GENIUSCUT_CLAUDE_MODEL overrides it (read per call)
FALLBACK_BETA = "server-side-fallback-2026-07-01"


class ClaudeError(LLMError):
    pass


KEY_REJECTED = "Your key was rejected — check the secret, or sign in again in Settings."


class KeyRejected(ClaudeError):
    """Anthropic refused the API key (401): the user fixes the secret or signs in again."""

    def __init__(self):
        super().__init__(KEY_REJECTED)


def provider() -> str:
    """The dev default Claude endpoint: `anthropic` or `vertex`. GENIUSCUT_LLM_PROVIDER wins when it names one."""
    chosen = (os.environ.get("GENIUSCUT_LLM_PROVIDER") or "").strip().lower()
    if chosen in ("anthropic", "vertex"):
        return chosen
    return (os.environ.get("GENIUSCUT_CLAUDE_PROVIDER") or "anthropic").strip().lower()


def model() -> str:
    """The dev default model name: GENIUSCUT_CLAUDE_MODEL, else MODEL (read per call)."""
    return (os.environ.get("GENIUSCUT_CLAUDE_MODEL") or "").strip() or MODEL


def model_id() -> str:
    """The catalog id of the dev default: `<provider()>:<model()>`."""
    return f"{provider()}:{model()}"


def default_entry() -> catalog.Entry:
    return catalog.entry_for(model_id())


def answered(response, asked: str) -> str:
    """The catalog id of the model that answered (a server-side fallback may differ)."""
    name = getattr(response, "model", None)
    return f"{asked.partition(':')[0]}:{name}" if isinstance(name, str) and name else asked


def require_price(cid: str) -> None:
    if spend.price(cid) is None:  # an unpriced model would skip the gate: unlimited spend
        raise ClaudeError(f"No price is known for Claude model '{cid}', so the monthly limit can't be "
                          f"enforced. Use one of: {', '.join(sorted(spend.PRICES))}.")


def _vertex_location() -> tuple[str, str]:
    from geniuscut import settings
    v = settings.load().vertex
    return (os.environ.get("GENIUSCUT_VERTEX_PROJECT") or v.project,
            os.environ.get("GENIUSCUT_VERTEX_REGION") or v.region)


def make_client(entry: catalog.Entry):
    """The SDK client for a Claude entry: Anthropic (reads the key) or AnthropicVertex (ADC)."""
    if entry.provider == "anthropic":
        return anthropic.Anthropic(api_key=secrets.anthropic_api_key())
    if entry.provider == "vertex":
        # Bare model IDs on Vertex; auth is the machine's gcloud application-default login.
        project, region = _vertex_location()
        return anthropic.AnthropicVertex(project_id=project, region=region)
    raise ClaudeError(f"{entry.id} isn't a Claude model.")


def default_client():
    """The client for the dev default (env) provider."""
    p = provider()
    if p not in ("anthropic", "vertex"):
        raise ClaudeError(f"Unknown GENIUSCUT_CLAUDE_PROVIDER {p!r}: use 'anthropic' or 'vertex'.")
    return make_client(default_entry())


def _api_message(e) -> str:
    body = getattr(e, "body", None)
    if isinstance(body, dict):
        msg = (body.get("error") or {}).get("message")
        if msg:
            return msg
    return str(e)


def _schema_prompt(prompt: str, schema: dict) -> str:
    return (f"{prompt}\n\nReply with only one JSON object that matches this JSON Schema, and no other text:\n"
            f"{json.dumps(schema)}")


def _call(prompt: str, *, entry: catalog.Entry | None, system: str | None, client, effort: str,
          max_tokens: int, schema: dict | None):
    entry = entry or default_entry()
    cid, p = entry.id, entry.params
    require_price(cid)
    if schema is not None and not (p.output_config and p.structured_output):
        prompt = _schema_prompt(prompt, schema)
    spend.check_budget(cid, (system or "") + prompt, max_tokens)
    client = client or make_client(entry)
    kwargs = dict(model=entry.model, max_tokens=max_tokens, messages=[{"role": "user", "content": prompt}])
    if p.output_config:
        output_config = {"effort": effort}
        if schema is not None and p.structured_output:
            output_config = {"format": {"type": "json_schema", "schema": schema}, "effort": effort}
        kwargs["output_config"] = output_config
    if system:
        kwargs["system"] = system
    if entry.provider == "vertex":
        create = client.messages.create
    else:
        if p.fallbacks:
            kwargs.update(betas=[FALLBACK_BETA], fallbacks="default")
        create = client.beta.messages.create
    with api_errors(cid):
        response = create(**kwargs)
    usage = getattr(response, "usage", None)
    if usage is not None:
        spend.record(answered(response, cid), int(getattr(usage, "input_tokens", 0) or 0),
                     int(getattr(usage, "output_tokens", 0) or 0), price_as=cid)
    if response.stop_reason == "refusal":
        details = getattr(response, "stop_details", None)
        raise ClaudeError(f"Claude declined the request ({getattr(details, 'category', None) or 'no category'}).")
    if response.stop_reason == "max_tokens":
        raise ClaudeError("Claude's reply was cut off at max_tokens. Try a shorter clip.")
    text = "".join(b.text for b in response.content if getattr(b, "type", None) == "text")
    if not text.strip():
        raise ClaudeError("Claude returned no text.")
    return text


def _note(cid: str | None, e: Exception) -> None:
    if cid:
        catalog.observe(cid, e)  # never raises


@contextmanager
def api_errors(cid: str | None = None):
    """Anthropic SDK errors as ClaudeError with a plain message; `cid`'s picker state notes the error."""
    try:
        yield
    except anthropic.AuthenticationError as e:
        _note(cid, e)
        raise KeyRejected() from e
    except anthropic.RateLimitError as e:
        raise ClaudeError(f"Anthropic is rate-limiting requests; try again shortly. {_api_message(e)}") from e
    except anthropic.APIStatusError as e:
        _note(cid, e)
        raise ClaudeError(f"Anthropic API error {e.status_code}: {_api_message(e)}") from e
    except anthropic.APIConnectionError as e:
        raise ClaudeError("Couldn't reach the Anthropic API. Check the internet connection.") from e
    except Exception as e:
        if type(e).__module__.startswith("google.auth"):
            _note(cid, e)
            raise ClaudeError("No Google Cloud login for Vertex AI on this machine. "
                              "Run: gcloud auth application-default login") from e
        raise


_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.S)


def _parse_json(text: str):
    m = _FENCE.match(text)
    return json.loads(m.group(1) if m else text)


def ask_json(prompt: str, schema: dict, *, entry: catalog.Entry | None = None, system: str | None = None,
             client=None, effort: str = "high", max_tokens: int = 16000) -> dict:
    text = _call(prompt, entry=entry, system=system, client=client, effort=effort, max_tokens=max_tokens,
                 schema=schema)
    try:
        return _parse_json(text)
    except json.JSONDecodeError as e:
        raise ClaudeError(f"Claude returned invalid JSON: {e}") from e


def check_key(source, *, run=subprocess.run, gcloud: str | None = None, make_client=None) -> dict:
    """The setup screen's "Test": read the key from `source` (Secret Manager only: no env var,
    no cache) and make one free authenticated call. Returns {ok, message}; never the key."""
    try:
        key = secrets.anthropic_api_key(run=run, gcloud=gcloud, source=source, fresh_only=True)
    except secrets.MissingKeyError as e:
        return {"ok": False, "message": str(e)}
    where = f"secret {source.secret} in project {source.project.strip()}"
    try:
        (make_client or anthropic.Anthropic)(api_key=key).models.retrieve(MODEL)
    except anthropic.AuthenticationError:
        message = f"Anthropic rejected the API key in {where}."
    except anthropic.APIStatusError as e:
        message = f"Anthropic API error {e.status_code}: {_api_message(e)}"
    except anthropic.APIConnectionError:
        message = "Couldn't reach the Anthropic API. Check the internet connection."
    else:
        return {"ok": True, "message": f"Connected: the API key in {where} works with {MODEL}."}
    return {"ok": False, "message": message.replace(key, "[redacted]")}


def ask_text(prompt: str, *, entry: catalog.Entry | None = None, system: str | None = None, client=None,
             effort: str = "medium", max_tokens: int = 16000) -> str:
    return _call(prompt, entry=entry, system=system, client=client, effort=effort, max_tokens=max_tokens,
                 schema=None)
