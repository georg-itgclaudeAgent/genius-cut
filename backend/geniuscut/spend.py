"""What the AI calls cost, a running monthly ledger, and the gate that stops a run before
the month's total would pass the limit.

- Every call is one JSON line in `<data dir>/spend.jsonl`. Append-only; a corrupt line is
  skipped, never fatal, and a ledger that can't be written never fails the call.
- Months are calendar months in UTC.
- Only priced models are gated. Claude has no price here, so its calls cost `None` and
  count as 0 towards the month.
"""

import json
import logging
import math
import os
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import date, datetime, timezone

from geniuscut import config
from geniuscut.errors import LLMError

log = logging.getLogger(__name__)

DEFAULT_LIMIT_USD = 2.0
LIMIT_ENV = "GENIUSCUT_MONTHLY_LIMIT_USD"

# USD per 1M tokens (input, output), Gemini API paid tier, prompts ≤200k tokens.
# Source: ai.google.dev/gemini-api/docs/pricing, checked 2026-10-05. Re-check before
# relying on them: Google changes these, and the Flash promo ends on 2026-12-31.
# Each model is a list of (first day the price applies, input, output), oldest first.
PRICES: dict[str, list[tuple[date, float, float]]] = {
    "gemini-3.7-flash": [(date.min, 0.75, 3.75), (date(2027, 1, 1), 1.50, 7.50)],
    "gemini-3.6-flash": [(date.min, 0.75, 3.75), (date(2027, 1, 1), 1.50, 7.50)],
    "gemini-3.5-flash": [(date.min, 1.50, 9.00)],
    "gemini-3.5-flash-lite": [(date.min, 0.30, 2.50)],
    "gemini-3.1-flash-lite": [(date.min, 0.25, 1.50)],
    "gemini-3.1-pro-preview": [(date.min, 2.00, 12.00)],
    "gemini-2.5-pro": [(date.min, 1.25, 10.00)],
    "gemini-2.5-flash": [(date.min, 0.30, 2.50)],
    "gemini-2.5-flash-lite": [(date.min, 0.10, 0.40)],
}


class BudgetExceeded(LLMError):
    """This call could take the month past the limit; nothing was sent."""


def _today() -> date:
    return datetime.now(timezone.utc).date()


def price(model: str, on: date | None = None) -> tuple[float, float] | None:
    tiers = PRICES.get(model)
    if not tiers:
        return None
    on = on or _today()
    current = None
    for since, inp, out in tiers:
        if on >= since:
            current = (inp, out)
    return current


def cost_usd(model: str, input_tokens: int, output_tokens: int, on: date | None = None) -> float | None:
    p = price(model, on)
    if p is None:
        return None
    return (input_tokens * p[0] + output_tokens * p[1]) / 1_000_000


def money(usd: float) -> str:
    """`$1.25`, or `<$0.01` for anything above zero but under a cent."""
    return "<$0.01" if 0 < usd < 0.01 else f"${usd:.2f}"


# ── meter ──────────────────────────────────────────────────────────

@dataclass
class Meter:
    """The calls made inside one `with meter():` block."""

    kind: str
    calls: list[tuple[str, int, int, float | None]] = field(default_factory=list)

    @property
    def usd(self) -> float | None:
        """Total of the priced calls; None only when calls ran and none was priced."""
        priced = [c[3] for c in self.calls if c[3] is not None]
        if self.calls and not priced:
            return None
        return sum(priced)

    @property
    def input_tokens(self) -> int:
        return sum(c[1] for c in self.calls)

    @property
    def output_tokens(self) -> int:
        return sum(c[2] for c in self.calls)

    @property
    def model(self) -> str | None:
        return self.calls[-1][0] if self.calls else None


_current: ContextVar[Meter | None] = ContextVar("geniuscut_spend_meter", default=None)


@contextmanager
def meter(kind: str = "other"):
    m = Meter(kind=kind)
    token = _current.set(m)
    try:
        yield m
    finally:
        _current.reset(token)


# ── ledger ─────────────────────────────────────────────────────────

def ledger_path():
    return config.data_dir() / "spend.jsonl"


def record(model: str, input_tokens: int, output_tokens: int, *, now: datetime | None = None) -> float | None:
    """Log one call's usage (to the ledger and any open meter); returns its cost."""
    now = now or datetime.now(timezone.utc)
    usd = cost_usd(model, input_tokens, output_tokens, on=now.astimezone(timezone.utc).date())
    m = _current.get()
    if m is not None:
        m.calls.append((model, input_tokens, output_tokens, usd))
    row = {"ts": now.astimezone(timezone.utc).isoformat(timespec="seconds"), "model": model,
           "kind": m.kind if m else "other", "input_tokens": input_tokens, "output_tokens": output_tokens,
           "usd": usd}
    try:
        path = ledger_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")
    except OSError as e:  # the call already happened; losing a ledger row must not lose the result
        log.warning("Couldn't write the AI spend ledger: %s", e)
    return usd


def month_total(now: datetime | None = None) -> float:
    """Sum of `usd` for the current calendar month in UTC. Unpriced rows count 0."""
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    try:
        lines = ledger_path().read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return 0.0
    total = 0.0
    for line in lines:
        try:
            row = json.loads(line)
            ts = datetime.fromisoformat(row["ts"])
            ts = (ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)
            usd = row.get("usd") or 0
            if isinstance(usd, bool) or not isinstance(usd, (int, float)):
                raise ValueError(f"usd is {usd!r}")
        except (ValueError, TypeError, KeyError, AttributeError) as e:
            if line.strip():
                log.warning("Skipping a corrupt spend ledger line: %s", e)
            continue
        if (ts.year, ts.month) == (now.year, now.month):
            total += usd
    return total


def limit_usd() -> float:
    """GENIUSCUT_MONTHLY_LIMIT_USD, default $2.00; anything invalid or negative means the default."""
    try:
        limit = float(os.environ.get(LIMIT_ENV, ""))
    except ValueError:
        return DEFAULT_LIMIT_USD
    return limit if math.isfinite(limit) and limit >= 0 else DEFAULT_LIMIT_USD


def check_budget(model: str, text: str, max_tokens: int, *, now: datetime | None = None) -> None:
    """Raise BudgetExceeded if this call's worst case would take the month past the limit.

    Worst case: the whole prompt (estimated at 3 characters per token, which overestimates
    English) plus a reply that uses every one of `max_tokens`.
    """
    worst = cost_usd(model, math.ceil(len(text) / 3), max_tokens,
                     on=(now or datetime.now(timezone.utc)).astimezone(timezone.utc).date())
    if worst is None:
        return
    so_far, limit = month_total(now), limit_usd()
    if so_far + worst > limit:
        raise BudgetExceeded(
            f"This run could cost up to {money(worst)}, and this month's AI spend is {money(so_far)} "
            f"of the {money(limit)} limit. Raise {LIMIT_ENV} to continue."
        )


# ── estimate ───────────────────────────────────────────────────────

WORDS_PER_MINUTE = 160
INPUT_TOKENS_PER_WORD = 4
FIXED_PROMPT_TOKENS = 700
FIXED_AMORTISED_OVER_MIN = 10
OUTPUT_BASE_TOKENS = 1500
OUTPUT_TOKENS_PER_WORD = 1.5


def estimate_per_minute(model: str, on: date | None = None) -> float | None:
    """Rough USD per minute of clip, for the panel's "Est." line. None if unpriced.

    Assumptions (calibrate against real ledger rows later):
    - 160 spoken words per minute;
    - input: 4 tokens per word (the numbered transcript, one word per line) plus the
      700-token system prompt and instructions, amortised over a 10-minute clip;
    - output: 1,500 + 1.5 × words tokens per minute, for the JSON ranges and the model's
      thinking (billed as output).
    It deliberately leans high: the panel would rather over-estimate.
    """
    words = WORDS_PER_MINUTE
    input_tokens = words * INPUT_TOKENS_PER_WORD + FIXED_PROMPT_TOKENS / FIXED_AMORTISED_OVER_MIN
    output_tokens = OUTPUT_BASE_TOKENS + OUTPUT_TOKENS_PER_WORD * words
    return cost_usd(model, input_tokens, output_tokens, on)
