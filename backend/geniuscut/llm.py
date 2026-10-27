"""The model switch: every Analyse call in Genius Cut goes through here.

The panel's model picker (`settings.model`, a catalog id) decides: `selected_id()` / `selected_entry()`.
`ask_json` / `ask_text` take the catalog entry to use (`entry=`) and route by its provider:
- `anthropic`: Claude on the Anthropic API, see `claude.py`;
- `vertex`: Claude on Google Cloud Vertex AI, also `claude.py`;
- `gemini`: the Gemini API, see `gemini.py` (the model is passed per call).
Without `entry`, the entry of the enclosing `using(entry)` block is used (trim.run_trim resolves the selection
once per Analyse and wraps its whole proposal in it), else the selection read now.

GENIUSCUT_LLM_PROVIDER (falling back to the older GENIUSCUT_CLAUDE_PROVIDER), GENIUSCUT_CLAUDE_MODEL and
GENIUSCUT_GEMINI_MODEL are dev-only overrides, read per call: when any is set, `selected_id()` is the model
they name (`model_id()`) instead of the picker's.
`LLMError` is the one error type callers catch; `claude.ClaudeError` and `spend.BudgetExceeded` are both
subclasses.
"""

import os
from contextlib import contextmanager
from contextvars import ContextVar

from geniuscut import catalog, claude, gemini, settings, spend
from geniuscut.errors import LLMError
from geniuscut.models import RunCost

__all__ = ["LLMError", "PROVIDERS", "provider", "model", "model_id", "selected_id", "selected_entry", "using",
           "current_entry", "ask_json", "ask_text", "run_cost"]

DEV_OVERRIDES = ("GENIUSCUT_LLM_PROVIDER", "GENIUSCUT_CLAUDE_PROVIDER", "GENIUSCUT_CLAUDE_MODEL",
                 "GENIUSCUT_GEMINI_MODEL")

PROVIDERS = ("gemini", "anthropic", "vertex")

_using: ContextVar[catalog.Entry | None] = ContextVar("geniuscut_llm_entry", default=None)


def provider() -> str:
    """The dev override's provider (GENIUSCUT_LLM_PROVIDER / GENIUSCUT_CLAUDE_PROVIDER), default anthropic."""
    for var in ("GENIUSCUT_LLM_PROVIDER", "GENIUSCUT_CLAUDE_PROVIDER"):
        raw = (os.environ.get(var) or "").strip().lower()
        if raw:
            if raw not in PROVIDERS:
                raise LLMError(f"Unknown {var} {raw!r}: use 'gemini', 'anthropic' or 'vertex'.")
            return raw
    return "anthropic"


def model() -> str:
    return gemini.model() if provider() == "gemini" else claude.model()


def model_id() -> str:
    """The catalog id the dev env override names (`anthropic:claude-opus-5-5` when none is set)."""
    return gemini.model_id() if provider() == "gemini" else claude.model_id()


def selected_id() -> str:
    """The model in use: a dev env override when one is set, else the picker's `settings.model`."""
    if any((os.environ.get(v) or "").strip() for v in DEV_OVERRIDES):
        return model_id()
    return settings.load().model


def selected_entry() -> catalog.Entry:
    """The selected model's catalog entry (an id outside the catalog gets an unpriced stand-in, refused
    at the price check)."""
    return catalog.entry_for(selected_id())


@contextmanager
def using(entry: catalog.Entry):
    """Calls inside without an explicit `entry` use this one (one Analyse = one model)."""
    token = _using.set(entry)
    try:
        yield entry
    finally:
        _using.reset(token)


def current_entry() -> catalog.Entry:
    return _using.get() or selected_entry()


def _route(entry: catalog.Entry | None):
    e = entry or current_entry()
    if e.provider == "gemini":
        return e, gemini, {"model": e.model}
    if e.provider in ("anthropic", "vertex"):
        return e, claude, {"entry": e}
    raise LLMError(f"Unknown AI model {e.id!r}: pick one from the list.")


def ask_json(prompt: str, schema: dict, *, entry: catalog.Entry | None = None, system: str | None = None,
             client=None, effort: str = "high", max_tokens: int = 16000) -> dict:
    _, backend, which = _route(entry)
    return backend.ask_json(prompt, schema, system=system, client=client, effort=effort, max_tokens=max_tokens,
                            **which)


def ask_text(prompt: str, *, entry: catalog.Entry | None = None, system: str | None = None, client=None,
             effort: str = "medium", max_tokens: int = 16000) -> str:
    _, backend, which = _route(entry)
    return backend.ask_text(prompt, system=system, client=client, effort=effort, max_tokens=max_tokens, **which)


def run_cost(m: spend.Meter, default: str | None = None) -> RunCost:
    """What one metered run cost, plus the month so far (read after the run's own calls). `default` names the
    run's model when no AI call ran (e.g. a pause-only Analyse, an agent run stopped before its first call)."""
    name = m.model or default
    if name is None:
        try:
            name = selected_id()
        except LLMError:
            name = "unknown"
    return RunCost(model=name, label=catalog.label(name) or name, provider=catalog.provider_of(name),
                   input_tokens=m.input_tokens, output_tokens=m.output_tokens,
                   usd=m.usd, month_usd=spend.month_total(), limit_usd=spend.limit_usd())
