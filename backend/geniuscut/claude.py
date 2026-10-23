"""One place that talks to Claude.

- Model `claude-opus-5-5` (override with GENIUSCUT_CLAUDE_MODEL).
- Provider: the Anthropic API (key from env/GSM) or Google Cloud Vertex AI
  (GENIUSCUT_LLM_PROVIDER or GENIUSCUT_CLAUDE_PROVIDER = vertex; bills the GCP project,
  uses the gcloud login). Reached through `llm.py`, whose default is this module on the
  Anthropic API; the key comes from the editor's own Secret Manager (`settings.json`).
- JSON comes back through structured outputs (`output_config.format`). Forced
  `tool_choice` returns a 400 on this model.
- Effort is always set explicitly; this model's default is `medium`. Thinking can't be
  turned off on Opus 5.5; it's billed as output, which `usage.output_tokens` includes.
- On the Anthropic API, server-side refusal fallback is on (`fallbacks="default"`), so a
  policy decline is retried on a fallback model inside the same call. Vertex doesn't offer it.
- A refusal or a truncated reply raises instead of being silently parsed.
- `agent_step` is one step of the panel's agent loop (agent.py): streamed, tools offered with
  `tool_choice` auto, effort high, adaptive thinking (the default: no `thinking` param), prompt
  caching on (`cache_control` auto), recorded under `response.model` with cache tokens.
- Envato Elements search (B-roll): on the Anthropic API, `agent_step(envato=True)` adds Envato's MCP
  server (https://mcp.envato.com/mcp, no auth) through Anthropic's MCP connector, with only
  `search_stock_video` and `search_photos` allowlisted. Anthropic runs those calls: they come back as
  mcp_tool_use / mcp_tool_result blocks, never as tool calls for the panel. GENIUSCUT_ENVATO=0 turns it
  off (`envato_enabled`); Vertex never gets it. An API error naming the MCP server raises EnvatoUnavailable,
  so the caller can retry the step without it. The ledger prices tokens only (MCP results arrive as input
  tokens); `usage.server_tool_use` isn't priced.
- Before every call the spend gate checks the worst case against the monthly limit, so a
  refused run never reaches the API; an unpriced model is refused. Usage is recorded in the
  spend ledger after every reply. Gate, prices and ledger use the catalog id (`model_id()`:
  `anthropic:claude-opus-5-5` or `vertex:claude-opus-5-5`); a reply is recorded under the id of the
  model that answered, priced as the id asked for when that one has no price. An API error also
  updates the model picker's cached state (catalog.observe), e.g. the workspace cap.
"""

import json
import os
import subprocess
from contextlib import contextmanager

import anthropic

from geniuscut import catalog, secrets, spend
from geniuscut.errors import LLMError

MODEL = os.environ.get("GENIUSCUT_CLAUDE_MODEL", "claude-opus-5-5")
FALLBACK_BETA = "server-side-fallback-2026-07-01"
AGENT_MAX_TOKENS = 32000  # a whole explainer composition plus thinking fits in one reply
MCP_BETA = "mcp-client-2025-11-20"
ENVATO_SERVER = {"type": "url", "url": "https://mcp.envato.com/mcp", "name": "envato"}
# Search only: every other Envato tool (downloads, licences…) stays off.
ENVATO_TOOLSET = {"type": "mcp_toolset", "mcp_server_name": "envato", "default_config": {"enabled": False},
                  "configs": {"search_stock_video": {"enabled": True}, "search_photos": {"enabled": True}}}


class ClaudeError(LLMError):
    pass


KEY_REJECTED = "Your key was rejected — check the secret, or sign in again in Settings."


class KeyRejected(ClaudeError):
    """Anthropic refused the API key (401): the user fixes the secret or signs in again."""

    def __init__(self):
        super().__init__(KEY_REJECTED)


class EnvatoUnavailable(ClaudeError):
    """The step failed because Anthropic couldn't use the Envato MCP server; retry it without Envato."""


def envato_enabled() -> bool:
    """Envato search rides along unless GENIUSCUT_ENVATO is 0/false/off/no, and only on the Anthropic API."""
    off = (os.environ.get("GENIUSCUT_ENVATO") or "").strip().lower() in ("0", "false", "off", "no")
    return not off and provider() == "anthropic"


def _mcp_failure(e) -> bool:
    msg = _api_message(e).lower()
    return "mcp" in msg or ENVATO_SERVER["name"] in msg


def provider() -> str:
    """Which Claude endpoint: `anthropic` or `vertex`. GENIUSCUT_LLM_PROVIDER wins when it names one."""
    chosen = (os.environ.get("GENIUSCUT_LLM_PROVIDER") or "").strip().lower()
    if chosen in ("anthropic", "vertex"):
        return chosen
    return (os.environ.get("GENIUSCUT_CLAUDE_PROVIDER") or "anthropic").strip().lower()


def model_id() -> str:
    """The catalog id of the model this module calls: `<provider()>:<MODEL>`."""
    return f"{provider()}:{MODEL}"


def _answered(response, asked: str) -> str:
    """The catalog id of the model that answered (a server-side fallback may differ)."""
    name = getattr(response, "model", None)
    return f"{asked.partition(':')[0]}:{name}" if isinstance(name, str) and name else asked


def _require_price(cid: str) -> None:
    if spend.price(cid) is None:  # an unpriced model would skip the gate: unlimited spend
        raise ClaudeError(f"No price is known for Claude model '{cid}', so the monthly limit can't be "
                          f"enforced. Use one of: {', '.join(sorted(spend.PRICES))}.")


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
    cid = model_id()
    _require_price(cid)
    spend.check_budget(cid, (system or "") + prompt, max_tokens)
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
    with _api_errors(cid):
        response = create(**kwargs)
    usage = getattr(response, "usage", None)
    if usage is not None:
        spend.record(_answered(response, cid), int(getattr(usage, "input_tokens", 0) or 0),
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
def _api_errors(cid: str | None = None):
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


def _tokens(usage, name: str) -> int:
    return int(getattr(usage, name, 0) or 0)


def agent_step(messages: list, tools: list[dict], system: str, *, client, input_tokens: int,
               envato: bool = False):
    """One agent step: gate on `input_tokens` (the caller's estimate) plus AGENT_MAX_TOKENS,
    stream, return the final message. The caller handles stop_reason (refusal, max_tokens,
    tool_use, end_turn) and appends `response.content` whole. Spend is recorded under the catalog id of the
    model that answered (an unpriced fallback is priced as `model_id()`), cache tokens included. `envato` adds the
    Envato MCP server and its search toolset (Anthropic API only); an API error about it raises
    EnvatoUnavailable."""
    cid = model_id()
    _require_price(cid)
    spend.check_tokens(cid, input_tokens, AGENT_MAX_TOKENS)
    kwargs = dict(model=MODEL, max_tokens=AGENT_MAX_TOKENS, system=system, tools=tools,
                  tool_choice={"type": "auto"}, messages=messages, output_config={"effort": "high"},
                  cache_control={"type": "ephemeral"})
    if provider() == "vertex":
        stream = client.messages.stream
    else:
        kwargs.update(betas=[FALLBACK_BETA], fallbacks="default")
        if envato:
            kwargs.update(betas=[FALLBACK_BETA, MCP_BETA], mcp_servers=[ENVATO_SERVER], tools=[*tools, ENVATO_TOOLSET])
        stream = client.beta.messages.stream
    with _api_errors(cid):
        try:
            with stream(**kwargs) as s:
                response = s.get_final_message()
        except anthropic.APIStatusError as e:
            if envato and "mcp_servers" in kwargs and e.status_code not in (401, 429) and _mcp_failure(e):
                raise EnvatoUnavailable(f"Envato search is unavailable: {_api_message(e)}") from e
            raise
    usage = getattr(response, "usage", None)
    if usage is not None:
        spend.record(_answered(response, cid), _tokens(usage, "input_tokens"),
                     _tokens(usage, "output_tokens"), cache_write=_tokens(usage, "cache_creation_input_tokens"),
                     cache_read=_tokens(usage, "cache_read_input_tokens"), price_as=cid)
    return response


def ask_json(prompt: str, schema: dict, *, system: str | None = None, client=None,
             effort: str = "high", max_tokens: int = 16000) -> dict:
    text = _call(prompt, system=system, client=client, max_tokens=max_tokens,
                 output_config={"format": {"type": "json_schema", "schema": schema}, "effort": effort})
    try:
        return json.loads(text)
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


def ask_text(prompt: str, *, system: str | None = None, client=None,
             effort: str = "medium", max_tokens: int = 16000) -> str:
    return _call(prompt, system=system, client=client, max_tokens=max_tokens,
                 output_config={"effort": effort})
