"""The whole proposal: range in, proposed cuts out. Nothing here touches the timeline.

Clock mapping (the easiest thing in this project to get confidently wrong):
ffmpeg extracts exactly the range from each source, so word time t=0 *is* the range start.
- sequence time (display) = range_start_seq_s + t   — no in-point term
- each clip's source time = its own in point + t (computed by the host)
"""

import shutil
import tempfile
from pathlib import Path
from typing import Callable

from geniuscut import audio, boundaries, cuts, library, llm, pauses, spend
from geniuscut.models import PAUSE_KEEP_S, CutSpan, SequenceCut, Span, TrimRequest, TrimResponse
from geniuscut.stt import Transcriber, read_wav_16k_mono


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
    refine: Callable = boundaries.refine,
    mix: Callable = audio.mix_wavs,
    place: Callable = audio.place_in_range,
) -> TrimResponse:
    work = Path(tempfile.mkdtemp(prefix="geniuscut-"))
    env = None
    duration = req.duration_s
    try:
        wavs = []
        for i, src in enumerate(req.audio):
            d = work / f"src{i}"
            d.mkdir()
            part = src.duration_s if src.duration_s is not None else duration - src.offset_s
            wav_i = extract(src.media_path, src.in_s, src.in_s + part, out_dir=d)
            if src.offset_s > 0 or part < duration - 0.001:
                wav_i = place(wav_i, src.offset_s, duration, d / "placed.wav")
            wavs.append(wav_i)
        wav = wavs[0] if len(wavs) == 1 else mix(wavs, work / "mix.wav")
        words = transcriber.transcribe(wav)
        try:
            env = boundaries.envelope(read_wav_16k_mono(wav))
        except Exception:  # noqa: BLE001 — edges are then widened without the silence check
            env = None
    finally:
        shutil.rmtree(work, ignore_errors=True)
    with spend.meter(kind="trim") as m:
        cut_spans = propose(words, library.build_fewshot(library_dir), req.prompt)
    cut_spans = refine(cut_spans, words, duration, env=env)
    if req.cut_pauses:
        cut_spans = pauses.merge_cuts(cut_spans, pauses.find_pauses(words, duration, req.min_pause_s, PAUSE_KEEP_S))
    if req.frame_s is not None:
        cut_spans = boundaries.snap_to_frames(cut_spans, words, duration, req.frame_s, env=env)
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
                          start_seq_s=_ms(req.range_start_seq_s + c.start),
                          end_seq_s=_ms(req.range_start_seq_s + c.end)) for c in cut_spans],
        kept_spans=[Span(start=_ms(s.start), end=_ms(s.end)) for s in kept],
        kept_spans_source=[Span(start=_ms(req.audio[0].in_s + s.start), end=_ms(req.audio[0].in_s + s.end))
                           for s in kept],
        stt_device=transcriber.device,
        cut_fraction=round(cut_fraction, 4),
        warning=warning,
        cost=llm.run_cost(m),
    )
