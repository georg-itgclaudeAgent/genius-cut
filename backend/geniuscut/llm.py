"""The provider switch: every AI call in Genius Cut goes through here.

GENIUSCUT_LLM_PROVIDER (falling back to the older GENIUSCUT_CLAUDE_PROVIDER) picks:
- `gemini` (default): the Gemini API, see `gemini.py`;
- `anthropic`: Claude on the Anthropic API;
- `vertex`: Claude on Google Cloud Vertex AI.
`LLMError` is the one error type callers catch; `claude.ClaudeError` and
`spend.BudgetExceeded` are both subclasses.
"""

import os

from geniuscut import claude, gemini, spend
from geniuscut.errors import LLMError
from geniuscut.models import RunCost

__all__ = ["LLMError", "PROVIDERS", "provider", "model", "ask_json", "ask_text", "run_cost"]

PROVIDERS = ("gemini", "anthropic", "vertex")


def provider() -> str:
    for var in ("GENIUSCUT_LLM_PROVIDER", "GENIUSCUT_CLAUDE_PROVIDER"):
        raw = (os.environ.get(var) or "").strip().lower()
        if raw:
            if raw not in PROVIDERS:
                raise LLMError(f"Unknown {var} {raw!r}: use 'gemini', 'anthropic' or 'vertex'.")
            return raw
    return "gemini"


def _backend():
    return gemini if provider() == "gemini" else claude


def model() -> str:
    return gemini.model() if provider() == "gemini" else claude.MODEL


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
            name = model()
        except LLMError:
            name = "unknown"
    return RunCost(model=name, input_tokens=m.input_tokens, output_tokens=m.output_tokens,
                   usd=m.usd, month_usd=spend.month_total(), limit_usd=spend.limit_usd())
