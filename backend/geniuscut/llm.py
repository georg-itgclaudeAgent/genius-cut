"""The provider switch: every AI call in Genius Cut goes through here.

GENIUSCUT_LLM_PROVIDER (falling back to the older GENIUSCUT_CLAUDE_PROVIDER) picks:
- `anthropic` (default): Claude Opus 5.5 on the Anthropic API, see `claude.py`;
- `gemini`: the Gemini API, see `gemini.py`;
- `vertex`: Claude on Google Cloud Vertex AI.
`LLMError` is the one error type callers catch; `claude.ClaudeError` and
`spend.BudgetExceeded` are both subclasses.

The panel's model picker (`settings.model`, a catalog id) is `selected_id()`; /health and the cost estimate
read it. The env vars above, GENIUSCUT_CLAUDE_MODEL and GENIUSCUT_GEMINI_MODEL are dev-only overrides: when
any is set, `selected_id()` is the model they name. (Until plan Task 2, Analyse and agent runs still route
by `model_id()`, the env switch, whose default is the picker's default.)
"""

import os

from geniuscut import catalog, claude, gemini, settings, spend
from geniuscut.errors import LLMError
from geniuscut.models import RunCost

__all__ = ["LLMError", "PROVIDERS", "provider", "model", "model_id", "selected_id", "ask_json", "ask_text",
           "run_cost"]

DEV_OVERRIDES = ("GENIUSCUT_LLM_PROVIDER", "GENIUSCUT_CLAUDE_PROVIDER", "GENIUSCUT_CLAUDE_MODEL",
                 "GENIUSCUT_GEMINI_MODEL")

PROVIDERS = ("gemini", "anthropic", "vertex")


def provider() -> str:
    for var in ("GENIUSCUT_LLM_PROVIDER", "GENIUSCUT_CLAUDE_PROVIDER"):
        raw = (os.environ.get(var) or "").strip().lower()
        if raw:
            if raw not in PROVIDERS:
                raise LLMError(f"Unknown {var} {raw!r}: use 'gemini', 'anthropic' or 'vertex'.")
            return raw
    return "anthropic"


def _backend():
    return gemini if provider() == "gemini" else claude


def model() -> str:
    return gemini.model() if provider() == "gemini" else claude.MODEL


def model_id() -> str:
    """The catalog id the env switch routes to (`anthropic:claude-opus-5-5` by default)."""
    return gemini.model_id() if provider() == "gemini" else claude.model_id()


def selected_id() -> str:
    """The model in use: a dev env override when one is set, else the picker's `settings.model`."""
    if any((os.environ.get(v) or "").strip() for v in DEV_OVERRIDES):
        return model_id()
    return settings.load().model


def ask_json(prompt: str, schema: dict, *, system: str | None = None, client=None,
             effort: str = "high", max_tokens: int = 16000) -> dict:
    return _backend().ask_json(prompt, schema, system=system, client=client, effort=effort, max_tokens=max_tokens)


def ask_text(prompt: str, *, system: str | None = None, client=None,
             effort: str = "medium", max_tokens: int = 16000) -> str:
    return _backend().ask_text(prompt, system=system, client=client, effort=effort, max_tokens=max_tokens)


def run_cost(m: spend.Meter) -> RunCost:
    """What one metered run cost, plus the month so far (read after the run's own calls)."""
    name = m.model
    if name is None:  # no AI call ran (e.g. a pause-only run): name the configured model
        try:
            name = model_id()
        except LLMError:
            name = "unknown"
    return RunCost(model=name, label=catalog.label(name) or name, provider=catalog.provider_of(name),
                   input_tokens=m.input_tokens, output_tokens=m.output_tokens,
                   usd=m.usd, month_usd=spend.month_total(), limit_usd=spend.limit_usd())
