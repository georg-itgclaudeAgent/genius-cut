"""Types shared by the backend and, via JSON, the panel.

Two clocks appear in this project and must never be mixed:
- **source time**: seconds into the media file (what ExtendScript's in/out points use);
- **sequence time**: seconds on the timeline (display only).
Field names carry the clock where it matters (`*_source_s`, `*_seq_s`).
"""

from pydantic import BaseModel, Field


class Word(BaseModel):
    """One transcribed word. `start`/`end` are seconds from the start of the extracted span."""

    w: str
    start: float
    end: float


class CutSpan(BaseModel):
    """A proposed removal, in span-relative seconds, with the words it removes and why."""

    start: float
    end: float
    text: str
    reason: str


class Span(BaseModel):
    start: float
    end: float


class ClipRef(BaseModel):
    media_path: str
    in_s: float = Field(description="Clip in point, source time")
    out_s: float = Field(description="Clip out point, source time")
    clip_start_s: float = Field(description="Where the clip starts on the timeline, sequence time")


class TrimRequest(ClipRef):
    prompt: str = ""


class SequenceCut(CutSpan):
    """A CutSpan also placed on the timeline, for display."""

    start_seq_s: float
    end_seq_s: float


class TrimResponse(BaseModel):
    words: list[Word]
    cuts: list[SequenceCut]
    kept_spans_source: list[Span] = Field(description="What the host re-lays, in source time")
    stt_device: str


class RemovedSpan(BaseModel):
    start: float
    end: float
    text: str
    reason: str = "edited out"


class StyleExample(BaseModel):
    id: str
    created: str
    source_clip: str
    raw_words: list[Word]
    final_text: str
    removed_spans: list[RemovedSpan]
