"""Per-call cost, the monthly ledger and the budget gate."""

import json
from datetime import date, datetime, timezone

import pytest

from geniuscut import config, llm, spend

UTC = timezone.utc


# ── prices ─────────────────────────────────────────────────────────

def test_flash_price_until_the_end_of_2026():
    # 1M in + 1M out at 0.75 / 3.75
    assert spend.cost_usd("gemini-3.7-flash", 1_000_000, 1_000_000, on=date(2026, 12, 31)) == pytest.approx(4.50)
    assert spend.cost_usd("gemini-3.6-flash", 1_000_000, 0, on=date(2026, 10, 5)) == pytest.approx(0.75)


def test_flash_price_doubles_from_2027_automatically():
    assert spend.cost_usd("gemini-3.7-flash", 1_000_000, 1_000_000, on=date(2027, 1, 1)) == pytest.approx(9.00)
    assert spend.cost_usd("gemini-3.6-flash", 0, 1_000_000, on=date(2027, 6, 1)) == pytest.approx(7.50)


@pytest.mark.parametrize("model, inp, out", [
    ("gemini-3.5-flash", 1.50, 9.00), ("gemini-3.5-flash-lite", 0.30, 2.50),
    ("gemini-3.1-flash-lite", 0.25, 1.50), ("gemini-3.1-pro-preview", 2.00, 12.00),
    ("gemini-2.5-pro", 1.25, 10.00), ("gemini-2.5-flash", 0.30, 2.50), ("gemini-2.5-flash-lite", 0.10, 0.40),
])
def test_fixed_prices(model, inp, out):
    on = date(2026, 10, 5)
    assert spend.cost_usd(model, 1_000_000, 0, on=on) == pytest.approx(inp)
    assert spend.cost_usd(model, 0, 1_000_000, on=on) == pytest.approx(out)


def test_unpriced_models_cost_none():
    assert spend.cost_usd("claude-opus-5-5", 1000, 1000, on=date(2026, 10, 5)) is None


def test_cost_defaults_to_today():
    assert spend.cost_usd("gemini-2.5-flash-lite", 1_000_000, 0) == pytest.approx(0.10)


# ── ledger ─────────────────────────────────────────────────────────

def test_ledger_lives_in_the_data_dir():
    assert spend.ledger_path() == config.data_dir() / "spend.jsonl"


def test_record_appends_one_row_per_call():
    now = datetime(2026, 10, 5, 3, 0, tzinfo=UTC)
    spend.record("gemini-3.7-flash", 1000, 2000, now=now)
    spend.record("claude-opus-5-5", 10, 20, now=now)
    rows = [json.loads(line) for line in spend.ledger_path().read_text(encoding="utf-8").splitlines()]
    assert len(rows) == 2
    assert rows[0]["model"] == "gemini-3.7-flash" and rows[0]["kind"] == "other"
    assert rows[0]["input_tokens"] == 1000 and rows[0]["output_tokens"] == 2000
    assert rows[0]["usd"] == pytest.approx(0.00075 + 0.0075)
    assert rows[0]["ts"].startswith("2026-10-05T03:00:00")
    assert rows[1]["usd"] is None


def test_month_total_sums_this_utc_month_only():
    spend.record("gemini-2.5-flash-lite", 1_000_000, 0, now=datetime(2026, 9, 30, 23, 59, tzinfo=UTC))  # 0.10 last month
    spend.record("gemini-2.5-flash-lite", 2_000_000, 0, now=datetime(2026, 10, 1, 0, 0, tzinfo=UTC))    # 0.20
    spend.record("gemini-2.5-flash-lite", 0, 1_000_000, now=datetime(2026, 10, 31, 23, 59, tzinfo=UTC))  # 0.40
    spend.record("claude-opus-5-5", 5, 5, now=datetime(2026, 10, 2, tzinfo=UTC))                          # unpriced: 0
    assert spend.month_total(now=datetime(2026, 10, 15, tzinfo=UTC)) == pytest.approx(0.60)
    assert spend.month_total(now=datetime(2026, 9, 1, tzinfo=UTC)) == pytest.approx(0.10)
    assert spend.month_total(now=datetime(2026, 11, 1, tzinfo=UTC)) == 0


def test_month_boundary_is_utc_not_local_time():
    # 2026-11-01 07:30 in Davao (UTC+8) is still October in UTC.
    from datetime import timedelta
    davao = timezone(timedelta(hours=8))
    spend.record("gemini-2.5-flash-lite", 1_000_000, 0, now=datetime(2026, 11, 1, 7, 30, tzinfo=davao))
    assert spend.month_total(now=datetime(2026, 10, 20, tzinfo=UTC)) == pytest.approx(0.10)
    assert spend.month_total(now=datetime(2026, 11, 2, tzinfo=UTC)) == 0


def test_corrupt_ledger_lines_are_skipped():
    path = spend.ledger_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    good = {"ts": "2026-10-05T01:00:00+00:00", "model": "m", "kind": "trim",
            "input_tokens": 1, "output_tokens": 1, "usd": 0.25}
    path.write_text("\n".join([
        "{not json", json.dumps(good), '{"ts": "yesterday", "usd": 9}', '{"ts": "2026-10-05T02:00:00+00:00", "usd": "lots"}',
        "[1, 2]", "", json.dumps(good),
    ]) + "\n", encoding="utf-8")
    assert spend.month_total(now=datetime(2026, 10, 9, tzinfo=UTC)) == pytest.approx(0.50)


def test_no_ledger_yet_means_nothing_spent():
    assert spend.month_total() == 0


# ── limit ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("raw, expected", [
    (None, 2.0), ("5", 5.0), (" 0.5 ", 0.5), ("0", 0.0), ("-1", 2.0), ("lots", 2.0), ("", 2.0), ("nan", 2.0), ("inf", 2.0),
])
def test_limit_parsing(monkeypatch, raw, expected):
    if raw is not None:
        monkeypatch.setenv("GENIUSCUT_MONTHLY_LIMIT_USD", raw)
    assert spend.limit_usd() == expected


# ── budget gate ────────────────────────────────────────────────────

def test_gate_passes_under_the_limit():
    spend.check_budget("gemini-3.7-flash", "x" * 3000, 16000)  # worst case ≈ $0.06


def test_gate_is_a_budget_exceeded_llm_error_with_the_exact_message(monkeypatch):
    monkeypatch.setenv("GENIUSCUT_MONTHLY_LIMIT_USD", "2")
    now = datetime(2026, 10, 5, tzinfo=UTC)
    spend.record("gemini-2.5-flash-lite", 0, 4_850_000, now=now)  # $1.94
    # est_input = ceil(3001 / 3) = 1001 tokens; worst case = 1001 * 0.75e-6 + 16000 * 3.75e-6 = $0.0608
    with pytest.raises(spend.BudgetExceeded) as e:
        spend.check_budget("gemini-3.7-flash", "x" * 3001, 16000, now=now)
    assert isinstance(e.value, llm.LLMError)
    assert str(e.value) == ("This run could cost up to $0.06, and this month's AI spend is $1.94 of the $2.00 limit. "
                            "Raise GENIUSCUT_MONTHLY_LIMIT_USD to continue.")


def test_gate_shows_tiny_amounts_as_under_a_cent(monkeypatch):
    monkeypatch.setenv("GENIUSCUT_MONTHLY_LIMIT_USD", "0.001")
    with pytest.raises(spend.BudgetExceeded) as e:
        spend.check_budget("gemini-2.5-flash-lite", "hi", 5000)  # worst case $0.002
    assert str(e.value).startswith("This run could cost up to <$0.01, and this month's AI spend is $0.00 of the <$0.01 limit.")


def test_gate_ignores_unpriced_models(monkeypatch):
    monkeypatch.setenv("GENIUSCUT_MONTHLY_LIMIT_USD", "0")
    spend.check_budget("claude-opus-5-5", "x" * 100_000, 16000)


def test_money_format():
    assert spend.money(0) == "$0.00"
    assert spend.money(0.004) == "<$0.01"
    assert spend.money(0.034) == "$0.03"
    assert spend.money(1.25) == "$1.25"


# ── meter ──────────────────────────────────────────────────────────

def test_meter_collects_every_call_inside_the_block_and_tags_the_kind():
    spend.record("gemini-2.5-flash-lite", 1_000_000, 0)  # outside: not counted
    with spend.meter(kind="trim") as m:
        spend.record("gemini-2.5-flash-lite", 1_000_000, 0)
        spend.record("gemini-2.5-flash-lite", 0, 1_000_000)
    spend.record("gemini-2.5-flash-lite", 1_000_000, 0)  # after: not counted
    assert m.usd == pytest.approx(0.50)
    assert (m.input_tokens, m.output_tokens, m.model) == (1_000_000, 1_000_000, "gemini-2.5-flash-lite")
    kinds = [json.loads(line)["kind"] for line in spend.ledger_path().read_text(encoding="utf-8").splitlines()]
    assert kinds == ["other", "trim", "trim", "other"]


def test_meter_with_no_calls_costs_zero():
    with spend.meter(kind="trim") as m:
        pass
    assert (m.usd, m.input_tokens, m.output_tokens, m.model) == (0.0, 0, 0, None)


def test_meter_usd_is_none_when_only_unpriced_calls_ran():
    with spend.meter() as m:
        spend.record("claude-opus-5-5", 100, 200)
    assert m.usd is None and m.input_tokens == 100 and m.model == "claude-opus-5-5"


def test_meter_counts_priced_calls_when_mixed_with_unpriced():
    with spend.meter() as m:
        spend.record("claude-opus-5-5", 100, 200)
        spend.record("gemini-2.5-flash-lite", 1_000_000, 0)
    assert m.usd == pytest.approx(0.10)


def test_an_unwritable_ledger_never_fails_the_call(monkeypatch, tmp_path):
    blocker = tmp_path / "blocker"
    blocker.write_text("a file, not a folder")
    monkeypatch.setenv("GENIUSCUT_DATA_DIR", str(blocker / "data"))
    with spend.meter() as m:
        spend.record("gemini-2.5-flash-lite", 1_000_000, 0)
    assert m.usd == pytest.approx(0.10)


# ── estimate ───────────────────────────────────────────────────────

def test_estimate_per_minute():
    # 160 words: input 160 * 4 + 700 / 10 = 710 tokens; output 1500 + 1.5 * 160 = 1740 tokens.
    expected = 710 * 0.75 / 1e6 + 1740 * 3.75 / 1e6
    assert spend.estimate_per_minute("gemini-3.7-flash", on=date(2026, 10, 5)) == pytest.approx(expected)
    assert spend.estimate_per_minute("claude-opus-5-5") is None
