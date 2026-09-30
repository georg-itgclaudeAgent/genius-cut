"""The whole proposal: clip in, proposed cuts out. Nothing here touches the timeline.

Clock mapping (the easiest thing in this project to get confidently wrong):
ffmpeg extracts exactly the clip's used span, so word time t=0 *is* the clip's in point.
- sequence time (display) = clip_start_s + t        — no in-point term
- source time (what the host re-lays) = in_s + t
"""

import shutil
import tempfile
from pathlib import Path
from typing import Callable

from geniuscut import audio, cuts, library
from geniuscut.models import CutSpan, SequenceCut, Span, TrimRequest, TrimResponse
from geniuscut.stt import Transcriber


HEAVY_CUT_FRACTION = 0.5


class TrimRefused(ValueError):
    """The proposal can't be applied safely; nothing should reach the timeline."""


def _ms(x: float) -> float:
    return round(x, 3)


def kept_spans(cut_spans: list[CutSpan], duration: float) -> list[Span]:
    """The complement of the cuts over [0, duration], span-relative, no zero-length pieces."""
    kept, cursor = [], 0.0
    for c in sorted(cut_spans, key=lambda c: c.start):
        start, end = max(0.0, c.start), min(duration, c.end)
        if start > cursor:
            kept.append(Span(start=cursor, end=start))
        cursor = max(cursor, end)
    if cursor < duration:
        kept.append(Span(start=cursor, end=duration))
    return [s for s in kept if s.end - s.start > 1e-6]


def run_trim(
    req: TrimRequest,
    transcriber: Transcriber,
    library_dir: Path,
    propose: Callable = cuts.propose_cuts,
    extract: Callable = audio.extract_span,
) -> TrimResponse:
    work = Path(tempfile.mkdtemp(prefix="geniuscut-"))
    try:
        wav = extract(req.media_path, req.in_s, req.out_s, out_dir=work)
        words = transcriber.transcribe(wav)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    cut_spans = propose(words, library.build_fewshot(library_dir), req.prompt)
    duration = req.out_s - req.in_s
    kept = kept_spans(cut_spans, duration)
    if not kept:
        raise TrimRefused("The proposal would remove the whole clip, so nothing was changed. "
                          "Try again, or trim this clip by hand.")
    cut_fraction = 1 - sum(s.end - s.start for s in kept) / duration
    warning = None
    if cut_fraction > HEAVY_CUT_FRACTION:
        warning = (f"These cuts remove {round(cut_fraction * 100)}% of the clip. "
                   "Check them carefully before applying.")
    return TrimResponse(
        words=words,
        cuts=[SequenceCut(**c.model_dump(),
                          start_seq_s=_ms(req.clip_start_s + c.start),
                          end_seq_s=_ms(req.clip_start_s + c.end)) for c in cut_spans],
        kept_spans_source=[Span(start=_ms(req.in_s + s.start), end=_ms(req.in_s + s.end)) for s in kept],
        stt_device=transcriber.device,
        cut_fraction=round(cut_fraction, 4),
        warning=warning,
    )
