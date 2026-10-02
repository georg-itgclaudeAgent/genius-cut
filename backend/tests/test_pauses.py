import pytest

from geniuscut.models import CutSpan, Word
from geniuscut.pauses import find_pauses, merge_cuts


def w(text, start, end):
    return Word(w=text, start=start, end=end)


WORDS = [w("So", 0.8, 1.0), w("the", 1.1, 1.3), w("thing", 3.7, 4.0), w("is", 4.1, 4.3)]


def test_a_long_gap_between_words_becomes_a_pause_cut_with_breathing_room():
    cuts = find_pauses(WORDS, duration=4.3, min_gap=1.0, keep=0.25)
    assert [(c.start, c.end, c.reason) for c in cuts] == [(1.55, 3.45, "pause")]
    assert cuts[0].text == "[pause 2.4s]"


def test_short_gaps_are_left_alone():
    assert find_pauses([w("a", 0, 0.5), w("b", 1.2, 1.5)], duration=1.5, min_gap=1.0, keep=0.25) == []


def test_dead_air_before_the_first_word_and_after_the_last():
    cuts = find_pauses([w("hello", 2.0, 2.5)], duration=5.0, min_gap=1.0, keep=0.25)
    # Leading: keep 0.25 s before the first word. Trailing: keep 0.25 s after the last.
    assert [(c.start, c.end) for c in cuts] == [(0.0, 1.75), (2.75, 5.0)]


def test_no_words_means_no_pause_cuts():
    # Nothing was said: that's not a clip to auto-trim, and cutting it all would empty it.
    assert find_pauses([], duration=10.0, min_gap=1.0, keep=0.25) == []


def test_gap_just_over_the_minimum_still_leaves_a_positive_cut():
    cuts = find_pauses([w("a", 0, 1.0), w("b", 2.05, 3.0)], duration=3.0, min_gap=1.0, keep=0.25)
    assert len(cuts) == 1 and cuts[0].end - cuts[0].start == pytest.approx(0.55)


@pytest.mark.parametrize("min_gap,keep", [(0.0, 0.25), (1.0, -0.1), (0.4, 0.25)])
def test_settings_that_would_cut_into_speech_are_rejected(min_gap, keep):
    # min_gap must leave room for `keep` on both sides; nothing negative.
    with pytest.raises(ValueError):
        find_pauses(WORDS, duration=4.3, min_gap=min_gap, keep=keep)


def test_merge_keeps_claude_cuts_and_pause_cuts_ordered_and_non_overlapping():
    claude = [CutSpan(start=0.8, end=1.3, text="So the", reason="filler")]
    pauses = [CutSpan(start=1.2, end=3.45, text="[pause 2.4s]", reason="pause"),
              CutSpan(start=5.0, end=6.0, text="[pause 1.5s]", reason="pause")]
    merged = merge_cuts(claude, pauses)
    assert [(c.start, c.end) for c in merged] == [(0.8, 1.3), (1.3, 3.45), (5.0, 6.0)]
    assert [c.reason for c in merged] == ["filler", "pause", "pause"]


def test_merge_drops_a_pause_entirely_inside_a_claude_cut():
    claude = [CutSpan(start=1.0, end=5.0, text="tangent", reason="tangent")]
    pauses = [CutSpan(start=2.0, end=3.0, text="[pause 1.5s]", reason="pause")]
    assert [(c.start, c.end, c.reason) for c in merge_cuts(claude, pauses)] == [(1.0, 5.0, "tangent")]
