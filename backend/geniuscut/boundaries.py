"""Move each proposed cut's edges to where the sound actually is.

Whisper's word timings are loose around fillers: on the real Checkpoint B clip (2026-10-05) it
put "uh" at 12.50-13.02 s while the sound was at 12.17-12.43 s, so cutting exactly the
word's window removed silence and left the "uh" on the timeline. The filler's sound is in the
gap between the neighbouring words, though, so a cut takes that whole gap, keeping `pad`
seconds of breathing room next to each neighbour. Fillers are murmurs that sit right against
one neighbour (straight after the previous word, or running into the next), so with the audio's
envelope each edge goes to the quietest moment near its neighbour: the dip between the filler
and the word. A cut is never made smaller than the words it removes.
"""

import numpy as np

from geniuscut.models import CutSpan, Word

FILLER_PAD_S = 0.05  # breathing room kept next to each neighbouring word
SEARCH_S = 0.15      # how far from a neighbour to look for the dip between it and a filler
SOLID_SOUND = 0.3    # a window never below this fraction of its peak has no gap, only dips
HOP = 160  # 10 ms at 16 kHz
EPS = 1e-3


def envelope(samples: np.ndarray, hop: int = HOP) -> np.ndarray:
    """RMS level in 10 ms frames (20 ms window), one value per frame."""
    x = np.asarray(samples, dtype=np.float32)
    if not len(x):
        return np.zeros(0, dtype=np.float32)
    rms = np.sqrt(np.convolve(x * x, np.ones(2 * hop, dtype=np.float32) / (2 * hop), mode="same"))
    return rms[::hop][: len(x) // hop]


def _quiet_level(env: np.ndarray) -> float:
    return max(0.003, float(np.percentile(env, 20)) * 3) if len(env) else 0.0


def _quietest(default: float, lo: float, hi: float, env: np.ndarray, quiet: float) -> float:
    """If there's sound in [lo, hi], the quietest moment there (ties: nearest `default`);
    otherwise `default`, which keeps the breathing room."""
    a, b = max(0, int(round(lo * 100))), min(len(env), int(round(hi * 100)) + 1)
    if b <= a or env[a:b].max() <= quiet:
        return default
    seg = env[a:b]
    if seg.min() > max(quiet, SOLID_SOUND * seg.max()):
        # Solid sound (a murmur running into a word): the boundary is the clearest dip, not the
        # lowest level, which is usually where the murmur fades in (real clip, 32.7 s). Anything
        # well below the window's peak, even faint room tone, counts as the gap instead.
        dip = _clearest_dip(seg)
        if dip is not None:
            return float((dip + a) / 100)
    lowest = np.flatnonzero(seg <= seg.min() + 1e-9) + a
    return float(lowest[np.argmin(np.abs(lowest / 100 - default))] / 100)


def _clearest_dip(seg: np.ndarray) -> int | None:
    """Index of the interior local minimum with the most prominence (how far it sits below
    the lower of the highest points either side of it), or None if there's no dip."""
    best, best_prom = None, 0.0
    for k in range(1, len(seg) - 1):
        if seg[k] <= seg[k - 1] and seg[k] <= seg[k + 1]:
            prom = min(seg[:k].max(), seg[k + 1:].max()) - seg[k]
            if prom > best_prom:
                best, best_prom = k, prom
    return best


def refine(cuts: list[CutSpan], words: list[Word], duration: float, pad: float = FILLER_PAD_S,
           env: np.ndarray | None = None) -> list[CutSpan]:
    if pad < 0:
        raise ValueError("pad can't be negative")
    quiet = _quiet_level(env) if env is not None else 0.0
    out = []
    for c in cuts:
        prev_end = max((x.end for x in words if x.end <= c.start + EPS), default=0.0)
        next_start = min((x.start for x in words if x.start >= c.end - EPS), default=duration)
        start = min(c.start, prev_end + pad)
        end = max(c.end, next_start - pad)
        if env is not None and len(env):
            # A filler sits against a neighbour: cut at the dip between them, never into the
            # neighbour as Whisper timed it, and never smaller than the words being removed.
            start = min(c.start, _quietest(start, prev_end, min(c.start, prev_end + SEARCH_S), env, quiet))
            end = max(c.end, _quietest(end, max(c.end, next_start - SEARCH_S), min(duration, next_start + 0.05), env, quiet))
        out.append(CutSpan(start=round(start, 3), end=round(end, 3), text=c.text, reason=c.reason))
    return out
