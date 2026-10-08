"""Long silences as proposed cuts, found locally from word timings (no Claude, no cost).

A pause of at least `min_gap` seconds between words, before the first word or after the
last, becomes a cut that leaves `keep` seconds of breathing room next to the speech, so
the edit doesn't feel clipped. The editor sees each one as a "pause" row and can untick it.
"""

from geniuscut.models import CutSpan, Word

MIN_PIECE = 1e-3


def _r(x: float) -> float:
    return round(x, 3)


def _pause(start: float, end: float, gap: float) -> CutSpan:
    return CutSpan(start=_r(start), end=_r(end), text=f"[pause {gap:.1f}s]", reason="pause")


def find_pauses(words: list[Word], duration: float, min_gap: float = 1.0, keep: float = 0.25) -> list[CutSpan]:
    if keep < 0:
        raise ValueError("keep can't be negative")
    if min_gap <= 2 * keep:
        raise ValueError(f"min_gap ({min_gap}s) must be longer than twice keep ({keep}s), or cuts would eat into speech")
    if not words:
        return []  # nothing was said: not a clip to auto-trim, and cutting it all would empty it
    ws = sorted(words, key=lambda w: w.start)
    cuts: list[CutSpan] = []
    if ws[0].start >= min_gap:
        cuts.append(_pause(0.0, ws[0].start - keep, ws[0].start))
    for a, b in zip(ws, ws[1:]):
        gap = b.start - a.end
        if gap >= min_gap:
            cuts.append(_pause(a.end + keep, b.start - keep, gap))
    tail = duration - ws[-1].end
    if tail >= min_gap:
        cuts.append(_pause(ws[-1].end + keep, duration, tail))
    return [c for c in cuts if c.end - c.start > MIN_PIECE]


def merge_cuts(claude: list[CutSpan], pauses: list[CutSpan]) -> list[CutSpan]:
    """Claude's cuts win; pause cuts are trimmed so nothing overlaps. Ordered by start."""
    taken = sorted(((c.start, c.end) for c in claude))
    out = list(claude)
    for p in pauses:
        pieces = [(p.start, p.end)]
        for s, e in taken:
            nxt = []
            for a, b in pieces:
                if e <= a or s >= b:
                    nxt.append((a, b))
                    continue
                if a < s:
                    nxt.append((a, s))
                if e < b:
                    nxt.append((e, b))
            pieces = nxt
        for a, b in pieces:
            if b - a > MIN_PIECE:
                out.append(CutSpan(start=_r(a), end=_r(b), text=p.text, reason=p.reason))
    return sorted(out, key=lambda c: c.start)
