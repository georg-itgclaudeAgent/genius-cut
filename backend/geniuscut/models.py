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


PAUSE_KEEP_S = 0.25  # breathing room left next to speech when a pause is cut


class AudioSource(BaseModel):
    """One audio clip on the timeline: its file and its source time at the range start."""

    media_path: str
    in_s: float = Field(ge=0, allow_inf_nan=False, description="Source time at the range start")


class TrimRequest(BaseModel):
    """A timeline range (synced clips that start and end together) and the audio to transcribe.
    Several sources are mixed for transcription only."""

    duration_s: float = Field(gt=0, allow_inf_nan=False)
    range_start_seq_s: float = Field(default=0.0, ge=0, allow_inf_nan=False,
                                     description="Where the range starts on the timeline, display only")
    audio: list[AudioSource] = Field(min_length=1)
    prompt: str = ""
    cut_pauses: bool = True
    min_pause_s: float = Field(default=1.0, le=30, allow_inf_nan=False,
                               description="Silences at least this long become pause cuts")

    @model_validator(mode="before")
    @classmethod
    def _from_single_clip(cls, data):
        """Panels before multi-clip sent one clip: {media_path, in_s, out_s, clip_start_s}."""
        if isinstance(data, dict) and "media_path" in data and "audio" not in data:
            d = dict(data)
            in_s, out_s = d.pop("in_s"), d.pop("out_s")
            if out_s <= in_s:
                raise ValueError(f"out_s ({out_s}) must be after in_s ({in_s})")
            d["audio"] = [{"media_path": d.pop("media_path"), "in_s": in_s}]
            d["duration_s"] = out_s - in_s
            d["range_start_seq_s"] = d.pop("clip_start_s", 0.0)
            return d
        return data

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
    kept_spans: list[Span] = Field(default_factory=list,
                                   description="What every recorded clip keeps, seconds from the range start")
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
