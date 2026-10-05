"""Types shared by the backend and, via JSON, the panel.

Two clocks appear in this project and must never be mixed:
- **source time**: seconds into the media file (what ExtendScript's in/out points use);
- **sequence time**: seconds on the timeline (display only).
Field names carry the clock where it matters (`*_source_s`, `*_seq_s`).
"""

from pydantic import BaseModel, Field, model_validator


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
    in_s: float = Field(ge=0, allow_inf_nan=False, description="Clip in point, source time")
    out_s: float = Field(ge=0, allow_inf_nan=False, description="Clip out point, source time")
    clip_start_s: float = Field(ge=0, allow_inf_nan=False,
                                description="Where the clip starts on the timeline, sequence time")

    @model_validator(mode="after")
    def _span_not_empty(self):
        if self.out_s <= self.in_s:
            raise ValueError(f"out_s ({self.out_s}) must be after in_s ({self.in_s})")
        return self


PAUSE_KEEP_S = 0.25  # breathing room left next to speech when a pause is cut


class TrimRequest(ClipRef):
    prompt: str = ""
    cut_pauses: bool = True
    min_pause_s: float = Field(default=1.0, le=30, allow_inf_nan=False,
                               description="Silences at least this long become pause cuts")

    @model_validator(mode="after")
    def _pause_leaves_breathing_room(self):
        if self.cut_pauses and self.min_pause_s <= 2 * PAUSE_KEEP_S:
            raise ValueError(f"min_pause_s must be over {2 * PAUSE_KEEP_S}s, or pause cuts would clip speech")
        return self


class SequenceCut(CutSpan):
    """A CutSpan also placed on the timeline, for display."""

    start_seq_s: float
    end_seq_s: float


class RunCost(BaseModel):
    """What one run's AI calls cost, and where the month stands afterwards. USD throughout."""

    model: str
    input_tokens: int
    output_tokens: int
    usd: float | None = Field(description="None when the model has no price (Claude)")
    month_usd: float
    limit_usd: float


class TrimResponse(BaseModel):
    words: list[Word]
    cuts: list[SequenceCut]
    kept_spans_source: list[Span] = Field(description="What the host re-lays, in source time")
    stt_device: str
    cut_fraction: float = 0.0
    warning: str | None = None
    cost: RunCost | None = None


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
