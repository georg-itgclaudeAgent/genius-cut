import numpy as np
import pytest

from geniuscut import boundaries
from geniuscut.models import CutSpan, Word

SR = 16000


def w(text, start, end):
    return Word(w=text, start=start, end=end)


def cut(start, end, reason="filler"):
    return CutSpan(start=start, end=end, text="uh", reason=reason)


# Shaped like the real clip (2026-10-05): Whisper put "uh" at 12.50-13.02, but the sound was at
# 12.17-12.43, in the gap after "Enterprise," (ends 12.08) and before "and" (starts 13.18).
WORDS = [w("Enterprise,", 11.5, 12.08), w("uh,", 12.50, 13.02), w("and", 13.18, 13.5)]


def test_a_filler_cut_takes_the_whole_gap_between_its_neighbours_minus_breathing_room():
    out = boundaries.refine([cut(12.50, 13.02)], WORDS, duration=14.0, pad=0.05)
    assert [(c.start, c.end) for c in out] == [(12.13, 13.13)]


def test_a_cut_is_never_made_smaller():
    words = [w("a", 0.0, 1.0), w("uh", 1.0, 2.0), w("b", 2.0, 3.0)]  # no gap at all
    out = boundaries.refine([cut(1.0, 2.0)], words, duration=3.0, pad=0.05)
    assert [(c.start, c.end) for c in out] == [(1.0, 2.0)]


def test_at_the_clip_edges_the_gap_runs_to_the_start_or_end():
    words = [w("uh", 0.6, 0.9), w("so", 1.4, 1.6), w("um", 2.2, 2.4)]
    out = boundaries.refine([cut(0.6, 0.9), cut(2.2, 2.4)], words, duration=3.0, pad=0.05)
    assert [(c.start, c.end) for c in out] == [(0.05, 1.35), (1.65, 2.95)]


def test_text_and_reason_are_kept():
    out = boundaries.refine([cut(12.50, 13.02, reason="repeat")], WORDS, duration=14.0)
    assert (out[0].text, out[0].reason) == ("uh", "repeat")


def _tone(spans, duration):
    t = np.arange(int(duration * SR)) / SR
    x = np.zeros_like(t, dtype=np.float32)
    for a, b in spans:
        m = (t >= a) & (t < b)
        x[m] = 0.3 * np.sin(2 * np.pi * 220 * t[m])
    return x + np.float32(0.001) * np.random.default_rng(0).standard_normal(len(t)).astype(np.float32)


def test_an_edge_that_would_land_on_sound_moves_back_into_silence():
    # "and" really starts at 13.06, earlier than Whisper's 13.18: the end edge (13.13) would clip it.
    samples = _tone([(11.5, 12.08), (12.17, 12.43), (13.06, 13.5)], 14.0)
    env = boundaries.envelope(samples)
    out = boundaries.refine([cut(12.50, 13.02)], WORDS, duration=14.0, pad=0.05, env=env)
    start, end = out[0].start, out[0].end
    assert start <= 12.17 and 13.02 <= end <= 13.06  # the whole "uh" goes, "and" is untouched


def _tone_with_dip(a, dip, b, duration):
    """One sound from a to b with a 20 ms near-silent dip at `dip`: a murmur running into a word."""
    return _tone([(a, dip), (dip + 0.02, b)], duration)


def test_a_filler_running_into_the_next_word_is_cut_at_the_dip_between_them():
    # Real clip: Whisper said "Um" 21.18-21.66 and "skills" from 21.82; the murmur was 21.63-21.80,
    # then a 20 ms dip, then "skills". Cutting at the dip removes the "um" and keeps the word.
    words = [w("left.", 20.3, 20.78), w("Um,", 21.18, 21.66), w("skills", 21.82, 22.3)]
    samples = _tone([(20.3, 20.78)], 23.0) + _tone_with_dip(21.63, 21.80, 22.3, 23.0)
    out = boundaries.refine([cut(21.18, 21.66)], words, duration=23.0, env=boundaries.envelope(samples))
    assert 21.79 <= out[0].end <= 21.83
    assert out[0].start <= 20.85


def test_with_no_silence_at_all_the_cut_goes_at_the_clearest_dip_not_the_lowest_level():
    # Real clip, 32.7 s: a murmur fades in (level 20 at 32.73), holds ~29, dips to 23 at
    # 32.85-32.86, then "and" (~35). The lowest frame is the fade-in; the boundary is the dip.
    t = np.arange(int(34.0 * SR)) / SR
    level = np.interp(t, [32.69, 32.73, 32.77, 32.84, 32.855, 32.875, 32.95, 33.05, 33.1],
                      [0.0, 0.020, 0.029, 0.029, 0.023, 0.035, 0.030, 0.020, 0.0])
    samples = (level * np.sqrt(2) * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    words = [w("us.", 31.4, 31.90), w("Um,", 32.12, 32.68), w("and", 32.88, 33.1)]
    out = boundaries.refine([cut(32.12, 32.68)], words, duration=34.0, env=boundaries.envelope(samples))
    assert 32.84 <= out[0].end <= 32.87


def test_faint_room_noise_before_the_next_word_still_counts_as_the_gap():
    # Real clip, 16.7 s: low room tone (~0.007, above a fixed "quiet" level) then "it's" at 16.75.
    # The edge must stay before the word, not hunt for a dip inside it.
    t = np.arange(int(18.0 * SR)) / SR
    # Near-silent room (0.001) except a faint breath (0.007) just before the word.
    level = np.where((t >= 16.75) & (t < 17.2), 0.04 + 0.01 * np.sin(2 * np.pi * 7 * t),
                     np.where((t >= 16.5) & (t < 16.75), 0.007, 0.001))
    samples = (level * np.sqrt(2) * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    words = [w("skills.", 15.0, 15.46), w("Uh,", 16.26, 16.74), w("it's", 16.86, 17.2)]
    out = boundaries.refine([cut(16.26, 16.74)], words, duration=18.0, env=boundaries.envelope(samples))
    assert 16.74 <= out[0].end <= 16.76


def test_a_filler_right_after_the_previous_word_is_cut_from_the_dip_after_that_word():
    # "because," ends 24.10 per Whisper but its sound runs to 24.14; the "uh" follows from 24.16.
    words = [w("because,", 23.6, 24.10), w("uh,", 24.20, 25.22), w("we're", 25.40, 25.8)]
    samples = _tone_with_dip(23.6, 24.14, 24.42, 26.0) + _tone([(25.32, 25.8)], 26.0)
    out = boundaries.refine([cut(24.20, 25.22)], words, duration=26.0, env=boundaries.envelope(samples))
    assert 24.13 <= out[0].start <= 24.16  # from the dip: "because" kept, the whole "uh" gone
    assert 25.22 <= out[0].end <= 25.32    # before "we're" really starts


def test_the_real_filler_sound_is_inside_the_cut_after_refining():
    samples = _tone([(11.5, 12.08), (12.17, 12.43), (13.18, 13.5)], 14.0)
    out = boundaries.refine([cut(12.50, 13.02)], WORDS, duration=14.0, env=boundaries.envelope(samples))
    assert out[0].start <= 12.17 and out[0].end >= 12.43


def test_envelope_is_ten_millisecond_frames():
    env = boundaries.envelope(np.zeros(SR, dtype=np.float32))
    assert len(env) == 100


@pytest.mark.parametrize("pad", [-0.01])
def test_negative_pad_is_rejected(pad):
    with pytest.raises(ValueError):
        boundaries.refine([cut(1, 2)], WORDS, duration=14.0, pad=pad)


# ── edges on the sequence's frames (clean cuts, 2026-10-08) ─────────
# Georg's 5:37 Apply: the host snapped each quiet edge to the 30 fps grid (±17 ms) and 24 of 34 splices
# landed on sound. With the sequence's frame length, each edge goes to the quietest frame boundary
# within one frame instead, so the host's rounding leaves it where it is.

F30 = 1 / 30
# "a" really sounds until 1.14 and "um" from 1.21; the gap is quiet. "b" really starts at 1.56.
SNAP_WORDS = [w("a", 0.0, 1.0), w("um", 1.2, 1.4), w("b", 1.6, 2.5)]


def _on_grid(x, frame):
    return abs(x / frame - round(x / frame)) < 1e-4  # edges are rounded to the microsecond


def test_each_edge_goes_to_the_quieter_frame_boundary_within_a_frame():
    env = boundaries.envelope(_tone([(0.0, 1.14), (1.21, 1.4), (1.56, 2.5)], 3.0))
    out = boundaries.snap_to_frames([cut(1.145, 1.555)], SNAP_WORDS, 3.0, F30, env=env)
    # start: 1.1333 is nearer but on "a"'s tail; 1.1667 is in the quiet. end: 1.5667 is on "b", 1.5333 is quiet.
    assert [(c.start, c.end) for c in out] == [(round(35 / 30, 6), round(46 / 30, 6))]
    assert all(_on_grid(x, F30) for x in (out[0].start, out[0].end))
    assert (out[0].text, out[0].reason) == ("uh", "filler")


def test_without_the_envelope_each_edge_goes_to_the_nearest_frame_boundary():
    out = boundaries.snap_to_frames([cut(1.145, 1.555)], SNAP_WORDS, 3.0, F30)
    assert [(c.start, c.end) for c in out] == [(round(34 / 30, 6), round(47 / 30, 6))]


def test_an_edge_never_crosses_into_a_neighbour_as_whisper_timed_it():
    words = [w("a", 0.0, 1.14), w("um", 1.2, 1.4), w("b", 1.55, 2.5)]
    out = boundaries.snap_to_frames([cut(1.145, 1.545)], words, 3.0, F30)
    # 1.1333 would cut into "a" (ends 1.14), 1.5667 into "b" (starts 1.55): the other boundary each time.
    assert [(c.start, c.end) for c in out] == [(round(35 / 30, 6), round(46 / 30, 6))]


def test_a_cut_never_shrinks_below_the_words_it_removes():
    words = [w("a", 0.0, 1.0), w("um", 1.16, 1.42), w("b", 1.6, 2.5)]
    out = boundaries.snap_to_frames([cut(1.16, 1.42)], words, 3.0, F30)
    # 1.1667 would leave the start of "um" (1.16), 1.4 would leave its end (1.42).
    assert [(c.start, c.end) for c in out] == [(round(34 / 30, 6), round(43 / 30, 6))]


def test_an_edge_with_no_frame_boundary_in_its_gap_stays_where_it_was():
    words = [w("a", 0.0, 1.14), w("um", 1.16, 1.4), w("b", 1.6, 2.5)]
    out = boundaries.snap_to_frames([cut(1.15, 1.5)], words, 3.0, F30)
    assert out[0].start == 1.15  # no boundary in [1.14, 1.16]: the host's rounding decides
    assert _on_grid(out[0].end, F30)


def test_a_pause_cut_is_snapped_too_and_stays_inside_the_range():
    words = [w("so", 0.1, 0.4), w("anyway", 3.3, 3.8)]
    out = boundaries.snap_to_frames([cut(0.65, 3.05, reason="pause"), cut(3.95, 4.0, reason="pause")], words, 4.0, 0.12)
    assert [(c.start, c.end) for c in out] == [(0.6, 3.0), (3.96, 4.0)]


def test_cuts_that_touched_still_touch():
    # A Claude cut and a pause cut sharing an edge must not leave a sliver of a frame between them.
    words = [w("a", 0.0, 1.0), w("um", 1.2, 1.4), w("b", 3.0, 3.5)]
    out = boundaries.snap_to_frames([cut(1.1, 1.45), cut(1.45, 2.75, reason="pause")], words, 4.0, F30)
    assert out[0].end == out[1].start
    assert all(_on_grid(x, F30) for c in out for x in (c.start, c.end))
