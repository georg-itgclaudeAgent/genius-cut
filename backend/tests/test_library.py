import json

import pytest

from geniuscut import library
from geniuscut.models import Word


def words(spec: str) -> list[Word]:
    """'so:0.0-0.2 um:0.3-0.5 …' → Word list."""
    out = []
    for token in spec.split():
        w, span = token.rsplit(":", 1)
        a, b = span.split("-")
        out.append(Word(w=w, start=float(a), end=float(b)))
    return out


RAW = words(
    "So,:0.00-0.26 um,:0.40-0.62 the:0.80-0.90 thing:0.90-1.10 about:1.10-1.30 "
    "Workspace:1.30-1.90 is,:1.90-2.10 uh,:2.40-2.60 most:2.90-3.10 resellers:3.10-3.70 "
    "get:3.70-3.85 it:3.85-3.95 wrong.:3.95-4.30"
)
FINAL = "The thing about Workspace is most resellers get it wrong."


def test_derives_removed_spans_with_raw_side_timings():
    spans = library.derive_removed_spans(RAW, FINAL)
    assert [(s.start, s.end, s.text) for s in spans] == [
        (0.00, 0.62, "So, um,"),
        (2.40, 2.60, "uh,"),
    ]


def test_normalisation_ignores_case_and_punctuation():
    assert library.derive_removed_spans(words("Hello,:0-1 WORLD!:1-2"), "hello world") == []


def test_replaced_words_count_as_removed_from_the_raw_side():
    spans = library.derive_removed_spans(words("we:0-1 migrate:1-2 tenants:2-3"), "we move tenants")
    assert [(s.start, s.end, s.text) for s in spans] == [(1.0, 2.0, "migrate")]


def test_add_example_round_trips_to_disk(tmp_path):
    ex = library.add_example(RAW, FINAL, "interview_take3.mp4", tmp_path, now="2026-09-30T10:04:11+08:00")
    assert ex.id == "2026-09-30-interview-take3"
    on_disk = json.loads((tmp_path / "examples" / f"{ex.id}.json").read_text(encoding="utf-8"))
    assert on_disk["source_clip"] == "interview_take3.mp4"
    assert len(on_disk["removed_spans"]) == 2
    assert library.list_examples(tmp_path)[0].id == ex.id


def test_same_clip_same_day_gets_a_unique_id(tmp_path):
    a = library.add_example(RAW, FINAL, "take3.mp4", tmp_path, now="2026-09-30T10:00:00+08:00")
    b = library.add_example(RAW, FINAL, "take3.mp4", tmp_path, now="2026-09-30T11:00:00+08:00")
    assert a.id != b.id
    assert len(library.list_examples(tmp_path)) == 2


def _seed(tmp_path, n):
    for i in range(n):
        library.add_example(RAW, FINAL, f"clip{i:02d}.mp4", tmp_path, now=f"2026-09-{i + 1:02d}T10:00:00+08:00")


def test_fewshot_under_12_sends_up_to_6_most_recent(tmp_path):
    _seed(tmp_path, 8)
    shot = library.build_fewshot(tmp_path)
    assert shot.summary is None
    assert [e.source_clip for e in shot.examples] == [f"clip{i:02d}.mp4" for i in (7, 6, 5, 4, 3, 2)]


def test_fewshot_at_12_or_more_sends_summary_plus_3_most_recent(tmp_path):
    _seed(tmp_path, 12)
    (tmp_path / "style-summary.md").write_text("- Cut every 'um'.", encoding="utf-8")
    shot = library.build_fewshot(tmp_path)
    assert shot.summary == "- Cut every 'um'."
    assert [e.source_clip for e in shot.examples] == ["clip11.mp4", "clip10.mp4", "clip09.mp4"]


def test_regenerate_summary_writes_what_the_model_returns(tmp_path):
    _seed(tmp_path, 2)
    seen = {}

    def fake_llm(prompt: str) -> str:
        seen["prompt"] = prompt
        return "- Remove filler words.\n- Keep technical terms."

    summary = library.regenerate_summary(tmp_path, fake_llm)
    assert summary.startswith("- Remove filler words.")
    assert (tmp_path / "style-summary.md").read_text(encoding="utf-8") == summary
    assert "So, um," in seen["prompt"]  # removed spans are shown to the model
    assert "25" in seen["prompt"]       # the ≤25-rules instruction


def test_regenerate_summary_needs_examples(tmp_path):
    with pytest.raises(ValueError):
        library.regenerate_summary(tmp_path, lambda p: "x")
