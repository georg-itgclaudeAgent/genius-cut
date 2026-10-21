"""The Claude side of an instruction run: the panel drives the tools, the backend owns Claude.

HTTP routes (all need `Authorization: Bearer <token>`; errors are `{"detail": "..."}`):
- `POST /agent/runs` `{"instruction": str (not blank), "selection": object, "sequence": object}`
  → step reply. `selection` is the selection snapshot taken when the instruction was sent (clip ids,
  span…), `sequence` a summary of the active sequence; both are passed to Claude as JSON.
- `POST /agent/runs/{run_id}/results` `{"results": [{"tool_use_id": str, "content": str, "is_error": bool}]}`
  → step reply. Exactly one result per tool call of the last reply (any order), else 422; 409 when the
  run isn't waiting for results.
- `POST /agent/runs/{run_id}/approve` (no body) → step reply. Only after a `plan` reply (else 409);
  appends "Approved: do exactly this plan." and steps.
- `DELETE /agent/runs/{run_id}` → `{"ok": true}` (always; discards the run).
- Unknown/finished/discarded run id → 404 `{"detail": "This run was lost; send the instruction again."}`.
  409 also when a step of the same run is already in progress.

Step reply (HTTP 200):
`{"run_id": str, "state": "tool_calls"|"plan"|"done"|"stopped",
  "tool_calls": [{"id": str, "name": str, "input": object}],   # non-empty only for "tool_calls"
  "text": str,                                                  # Claude's text in this reply ("" if none)
  "message": str|null, "reason": "limit"|"key"|"error"|"refusal"|"max_tokens"|"step_cap"|null,  # "stopped" only
  "cost": {"model": str, "input_tokens": int, "output_tokens": int, "usd": float|null,
           "month_usd": float, "limit_usd": float}}            # usd = this run's total so far
- `tool_calls`: run them (act tools before approval answer "Not approved yet: describe the plan
  instead" with is_error true) and post the results.
- `plan`: Claude's plan (text) before approval; show Go / Cancel. Go = approve.
- `done`: the approved run finished; text is Claude's summary. The run is closed.
- `stopped`: the run is closed; show `message` (for `limit`, the exact limit message).
- `propose_filler_cuts` is terminal: a `tool_calls` reply containing it closes the run on the
  backend. The panel runs today's Analyse with its `instructions` and opens the review; it posts no
  results.

Rules (spec "Run rules → Agent loop"): the conversation is append-only (responses appended whole,
thinking included; never edited); a refusal or a reply cut off at max_tokens ends the run and is not
appended or executed; at most 25 Claude steps per run; every step goes through the spend gate,
estimated from the previous step's actual usage plus the new content; the Anthropic client (and so
the key read) is made once per run. Runs live in memory: a backend restart loses them.
"""

import json
import math
import threading
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Callable

from geniuscut import claude, llm, secrets, spend
from geniuscut.errors import LLMError

MAX_STEPS = 25
LOST = "This run was lost; send the instruction again."
APPROVED = "Approved: do exactly this plan."

# ── tools (what Claude sees; the panel's tool table runs them) ─────────────────────

_SECONDS = "Seconds on the sequence timeline (the times get_sequence reports), not source-media time."
_STALE = ("Clip ids come from get_sequence and go stale after any edit: call get_sequence again after an edit "
          "before using ids.")
_SEQ_ID = {"type": "string", "description": "The sequenceId from get_sequence. Refused if another sequence is open now."}
_UNDO = "The user can undo it with the panel's Undo button."

TOOLS: list[dict] = [
    {
        "name": "get_sequence",
        "description": (
            "Read the active Premiere sequence: sequenceId, name, fps, durationS, tracks [{kind, index, name, muted}], "
            "clips [{id, track, name, startS, endS, inS, source, selected, enabled, effects, speed}], markers [{id, "
            "startS, endS, name, comments, colour}] and selection (ids of the selected clips). All times are seconds "
            "on the sequence timeline (inS is the clip's in point in its source; effects names the clip's added "
            "effects, which cut_ranges, move_clips and close_gaps would remove; speed is 1 at 100%, and get_transcript, "
            "cut_ranges, move_clips, close_gaps and delete_clips refuse any other). Track and clip numbering is 1-based, as Premiere shows it (V1, A2). Call this first, and again "
            "after every edit: clip ids change when clips are cut or moved. Optional fromS/toS list only the clips "
            "and markers overlapping that stretch."),
        "input_schema": {
            "type": "object",
            "properties": {
                "fromS": {"type": "number", "minimum": 0, "description": "Start of the stretch to list. " + _SECONDS},
                "toS": {"type": "number", "minimum": 0, "description": "End of the stretch to list. " + _SECONDS},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_transcript",
        "description": (
            "Transcribe what is said in chosen clips (clipIds from get_sequence) over their time on the timeline. "
            "Returns the words with their times in seconds on the sequence timeline when the transcript is ready "
            "(cached from an earlier Analyse or call). Otherwise it starts a transcription job and returns {id, "
            "status, progress}; then call wait_transcript with that id until it returns the words."),
        "input_schema": {
            "type": "object",
            "properties": {
                "clipIds": {"type": "array", "items": {"type": "string"}, "minItems": 1,
                            "description": "Clip ids from get_sequence. " + _STALE},
            },
            "required": ["clipIds"],
            "additionalProperties": False,
        },
    },
    {
        "name": "wait_transcript",
        "description": (
            "Wait (up to about 60 s) for a transcription job that get_transcript started. Returns the words with "
            "times in seconds on the sequence timeline when done, or the job's {id, status, progress} again if it "
            "is still running (call wait_transcript again). status \"loading\" means the speech model is still "
            "loading."),
        "input_schema": {
            "type": "object",
            "properties": {"id": {"type": "string", "description": "The job id get_transcript returned."}},
            "required": ["id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "add_markers",
        "description": (
            "Add sequence markers (for example YouTube chapters or notes for the editor). Each marker: atS (where it "
            "starts), optional endS for a range marker, name, optional comments, optional colour (Premiere's marker "
            "colour index 0-7). " + _SECONDS + " All markers are checked first; if any can't be made, none are left "
            "behind. Returns the created marker ids. " + _UNDO),
        "input_schema": {
            "type": "object",
            "properties": {
                "sequenceId": _SEQ_ID,
                "markers": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "atS": {"type": "number", "minimum": 0, "description": "Marker start. " + _SECONDS},
                            "endS": {"type": "number", "minimum": 0,
                                     "description": "Optional end, for a range marker (at or after atS). " + _SECONDS},
                            "name": {"type": "string", "minLength": 1, "description": "The marker's name."},
                            "comments": {"type": "string", "description": "Optional marker comments."},
                            "colour": {"type": "integer", "minimum": 0, "maximum": 7,
                                       "description": "Optional Premiere marker colour index, 0-7."},
                        },
                        "required": ["atS", "name"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["sequenceId", "markers"],
            "additionalProperties": False,
        },
    },
    {
        "name": "cut_ranges",
        "description": (
            "Cut stretches of time out of chosen clips, using Genius Cut's Apply engine: every chosen track is cut "
            "in sync, the kept pieces close up among themselves, the result is verified, and it is all or nothing. "
            "It leaves a gap of removedS at the end of the chosen clips; later clips don't move. clipIds are ids "
            "from get_sequence (include the linked audio clips you want cut too; unchosen clips that would be "
            "overwritten make the call refuse). ranges are [{fromS, toS}] in seconds on the sequence timeline, "
            "clipped to the chosen clips' span. Cutting rebuilds the chosen clips from their source: effects on "
            "them (get_sequence lists them) are removed, so the call refuses, naming them, unless acceptEffectLoss "
            "is true; set it only when the approved plan said the effects will be lost. Intrinsic keyframes "
            "(Motion, Opacity, Volume) and audio gain are not kept either: they are rebuilt from the source. "
            + _STALE + " " + _UNDO),
        "input_schema": {
            "type": "object",
            "properties": {
                "sequenceId": _SEQ_ID,
                "clipIds": {"type": "array", "items": {"type": "string"}, "minItems": 1,
                            "description": "The clips to cut, ids from get_sequence. " + _STALE},
                "ranges": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "fromS": {"type": "number", "minimum": 0,
                                      "description": "Start of the stretch to remove. " + _SECONDS},
                            "toS": {"type": "number", "minimum": 0,
                                    "description": "End of the stretch to remove. " + _SECONDS},
                        },
                        "required": ["fromS", "toS"],
                        "additionalProperties": False,
                    },
                },
                "acceptEffectLoss": {
                    "type": "boolean",
                    "description": "Set true only when the approved plan said the effects on these clips will be lost.",
                },
            },
            "required": ["sequenceId", "clipIds", "ranges"],
            "additionalProperties": False,
        },
    },
    {
        "name": "delete_clips",
        "description": (
            "Delete the chosen clips from the timeline. Nothing slides: their place is left empty, and a linked "
            "partner (a video clip's own sound) that isn't chosen stays. Refuses a locked track and a clip not at 100% "
            "speed. The reply's warning names effects an undo couldn't bring back (an undo lays the clips back from "
            "their source). " + _STALE + " " + _UNDO),
        "input_schema": {
            "type": "object",
            "properties": {
                "sequenceId": _SEQ_ID,
                "clipIds": {"type": "array", "items": {"type": "string"}, "minItems": 1,
                            "description": "The clips to delete, ids from get_sequence. " + _STALE},
            },
            "required": ["sequenceId", "clipIds"],
            "additionalProperties": False,
        },
    },
    {
        "name": "close_gaps",
        "description": (
            "Close the gaps between the chosen clips (the stretches inside their span none of them covers): every "
            "clip on EVERY track that starts after a gap moves left by the gaps before it, so everything after stays "
            "in step. This reaches beyond the selection: the plan must say so (\"this also moves everything after "
            "2:10\"). Each moved clip is taken off and laid again from its source: its effects are removed (refused, "
            "naming them, unless acceptEffectLoss is true) and its clip volume, Motion and Opacity settings are reset. "
            "Refuses, moving nothing: no gap, a clip on any track sitting in a gap, a locked track, a clip not at 100% "
            "speed. The reply's idMap maps each moved clip's old id to its new one. " + _STALE + " " + _UNDO),
        "input_schema": {
            "type": "object",
            "properties": {
                "sequenceId": _SEQ_ID,
                "clipIds": {"type": "array", "items": {"type": "string"}, "minItems": 2,
                            "description": "The selected clips whose gaps to close, ids from get_sequence. " + _STALE},
                "acceptEffectLoss": {
                    "type": "boolean",
                    "description": "Set true only when the approved plan said the effects on the moved clips will be lost.",
                },
            },
            "required": ["sequenceId", "clipIds"],
            "additionalProperties": False,
        },
    },
    {
        "name": "split_at",
        "description": (
            "Split each chosen clip in two at atS (to the nearest frame), as Premiere's razor does on that clip's own "
            "track; a linked partner that isn't chosen stays whole. atS must fall inside every chosen clip. The reply's "
            "idMap maps each split clip's id to its two pieces' ids. " + _SECONDS + " " + _STALE + " " + _UNDO),
        "input_schema": {
            "type": "object",
            "properties": {
                "sequenceId": _SEQ_ID,
                "clipIds": {"type": "array", "items": {"type": "string"}, "minItems": 1,
                            "description": "The clips to split, ids from get_sequence. " + _STALE},
                "atS": {"type": "number", "minimum": 0, "description": "Where to split. " + _SECONDS},
            },
            "required": ["sequenceId", "clipIds", "atS"],
            "additionalProperties": False,
        },
    },
    {
        "name": "set_clip_enabled",
        "description": (
            "Switch the chosen clips off (enabled false: they stay on the timeline but don't play or show) or on "
            "again, as the timeline's Enable does. " + _STALE + " " + _UNDO),
        "input_schema": {
            "type": "object",
            "properties": {
                "sequenceId": _SEQ_ID,
                "clipIds": {"type": "array", "items": {"type": "string"}, "minItems": 1,
                            "description": "The clips to switch, ids from get_sequence. " + _STALE},
                "enabled": {"type": "boolean", "description": "true switches them on, false off."},
            },
            "required": ["sequenceId", "clipIds", "enabled"],
            "additionalProperties": False,
        },
    },
    {
        "name": "move_clips",
        "description": (
            "Move each chosen clip along its own track by byS seconds (to the nearest frame; negative moves left), all "
            "or nothing. A linked partner moves only when it is chosen too (choose a clip's own sound with it to keep "
            "them in sync). Refuses, moving nothing: landing on any clip that isn't moving with it, a move before the "
            "sequence start or of less than a frame, a locked track, a clip not at 100% speed. Each moved clip is taken "
            "off and laid again from its source: its effects are removed (refused, naming them, unless "
            "acceptEffectLoss is true) and its clip volume, Motion and Opacity settings are reset. The reply's idMap "
            "maps each moved clip's old id to its new one. " + _STALE + " " + _UNDO),
        "input_schema": {
            "type": "object",
            "properties": {
                "sequenceId": _SEQ_ID,
                "clipIds": {"type": "array", "items": {"type": "string"}, "minItems": 1,
                            "description": "The clips to move, ids from get_sequence. " + _STALE},
                "byS": {"type": "number", "description": "How far to move them, in seconds; negative moves left."},
                "acceptEffectLoss": {
                    "type": "boolean",
                    "description": "Set true only when the approved plan said the effects on these clips will be lost.",
                },
            },
            "required": ["sequenceId", "clipIds", "byS"],
            "additionalProperties": False,
        },
    },
    {
        "name": "switch_angle",
        "description": (
            "Multi-camera angle choice: for the stretch fromS-toS, show the angle on video track showTrack. Every "
            "chosen video clip overlapping the stretch is split at fromS and toS where they fall inside it; its piece "
            "inside the stretch is switched off, except showTrack's, which is switched on. Audio isn't touched. "
            "clipIds are the angles' video clips (one on showTrack must cover the whole stretch). This switches off "
            "pieces on the other angle tracks: the plan must say so (\"V1 and V3 are switched off from 1:00 to "
            "1:10\"). The reply's idMap maps each split clip's id to its pieces' ids. " + _SECONDS + " " + _STALE
            + " " + _UNDO),
        "input_schema": {
            "type": "object",
            "properties": {
                "sequenceId": _SEQ_ID,
                "clipIds": {"type": "array", "items": {"type": "string"}, "minItems": 1,
                            "description": "The angles' video clips, ids from get_sequence. " + _STALE},
                "fromS": {"type": "number", "minimum": 0, "description": "Start of the stretch. " + _SECONDS},
                "toS": {"type": "number", "minimum": 0, "description": "End of the stretch. " + _SECONDS},
                "showTrack": {"type": "integer", "minimum": 1,
                              "description": "The video track to show (1 for V1)."},
            },
            "required": ["sequenceId", "clipIds", "fromS", "toS", "showTrack"],
            "additionalProperties": False,
        },
    },
    {
        "name": "set_volume",
        "description": (
            "Set the chosen audio clips' clip volume to db decibels (Effect Controls > Volume > Level; 0 is unchanged, "
            "at most +15). Refuses a video clip, volume keyframes and a locked track. A later cut or move of the clip "
            "resets this, so in one plan set volume after cutting or moving. " + _STALE + " " + _UNDO),
        "input_schema": {
            "type": "object",
            "properties": {
                "sequenceId": _SEQ_ID,
                "clipIds": {"type": "array", "items": {"type": "string"}, "minItems": 1,
                            "description": "The audio clips, ids from get_sequence. " + _STALE},
                "db": {"type": "number", "maximum": 15, "description": "The clip volume in decibels (-6 is quieter)."},
            },
            "required": ["sequenceId", "clipIds", "db"],
            "additionalProperties": False,
        },
    },
    {
        "name": "mute_track",
        "description": (
            "Mute or unmute a whole track (the track's mute switch). It reaches beyond the selection: the plan must say "
            "so (\"this mutes all of A2\"). Only a track that has a selected clip. " + _UNDO),
        "input_schema": {
            "type": "object",
            "properties": {
                "sequenceId": _SEQ_ID,
                "kind": {"type": "string", "enum": ["audio", "video"], "description": "The track's kind."},
                "track": {"type": "integer", "minimum": 1, "description": "The track number (1 for A1 or V1)."},
                "muted": {"type": "boolean", "description": "true mutes, false unmutes."},
            },
            "required": ["sequenceId", "kind", "track", "muted"],
            "additionalProperties": False,
        },
    },
    {
        "name": "add_transition",
        "description": (
            "Add a transition at the chosen clip's start or end, seconds long (to the frame), centred on the edit: "
            "Cross Dissolve on video, Constant Power on audio. Genius Cut's Undo can't remove it (Premiere has no "
            "script call for that): the plan must say so; the user removes it by hand or with Premiere's Undo. "
            + _STALE),
        "input_schema": {
            "type": "object",
            "properties": {
                "sequenceId": _SEQ_ID,
                "clipId": {"type": "string", "description": "The clip, its id from get_sequence. " + _STALE},
                "at": {"type": "string", "enum": ["start", "end"], "description": "Which edge of the clip."},
                "seconds": {"type": "number", "exclusiveMinimum": 0,
                            "description": "The transition's length in seconds (at least a frame)."},
            },
            "required": ["sequenceId", "clipId", "at", "seconds"],
            "additionalProperties": False,
        },
    },
    {
        "name": "set_speed",
        "description": (
            "Play the chosen clips at speed (1 = 100%, 2 = twice as fast, 0.5 = half). Each keeps its place and length "
            "on the timeline, so nothing else moves; its content plays faster or slower. A clip whose own sound or "
            "picture isn't chosen with it is refused (they would go out of sync), and so is a reversed clip. Afterwards "
            "get_transcript, cut_ranges, move_clips and close_gaps refuse the clip. " + _STALE + " " + _UNDO),
        "input_schema": {
            "type": "object",
            "properties": {
                "sequenceId": _SEQ_ID,
                "clipIds": {"type": "array", "items": {"type": "string"}, "minItems": 1,
                            "description": "The clips, ids from get_sequence. " + _STALE},
                "speed": {"type": "number", "exclusiveMinimum": 0, "maximum": 100,
                          "description": "The speed: 1 is 100%."},
            },
            "required": ["sequenceId", "clipIds", "speed"],
            "additionalProperties": False,
        },
    },
    {
        "name": "propose_filler_cuts",
        "description": (
            "Hand a filler-word / pause trim of the selected clips to Genius Cut's own trim review: the panel runs "
            "its Analyse on the selection with your instructions and opens the review, where the user applies or "
            "restores the cuts. Use it for instructions like \"trim the ums\" or \"remove the long pauses\". It needs "
            "no plan or approval and it ends this run: call it alone, as your only tool call, and do nothing after."),
        "input_schema": {
            "type": "object",
            "properties": {
                "instructions": {"type": "string", "minLength": 1,
                                 "description": "What to trim, in plain words, for the trim engine (e.g. 'remove "
                                                "ums, ahs and repeated starts; keep breaths')."},
            },
            "required": ["instructions"],
            "additionalProperties": False,
        },
    },
]

# read: any time; act: only after approval (the panel enforces); terminal: ends the run.
TOOL_KINDS = {"get_sequence": "read", "get_transcript": "read", "wait_transcript": "read",
              "add_markers": "act", "cut_ranges": "act", "delete_clips": "act", "close_gaps": "act", "split_at": "act",
              "set_clip_enabled": "act", "move_clips": "act", "switch_angle": "act", "set_volume": "act",
              "mute_track": "act", "add_transition": "act", "set_speed": "act", "propose_filler_cuts": "terminal"}

SYSTEM = """You are the assistant inside Genius Cut, a Premiere Pro panel. The user typed an instruction about \
the clips they selected on the timeline. You edit the active sequence only through the tools.

Selection rules
- Change only the selected clips (the ids in the selection snapshot) and the pieces your own edit tools \
return in this run. Markers go inside the selected clips' time span. Read tools may look at the whole sequence.
- If something can only be done by touching material outside the selection, say so in plain words in the plan \
("this also moves everything after 2:10", "this mutes all of A2").
- Three tools reach beyond the selection by nature, and the plan must say so in plain words each time: close_gaps \
moves every clip on every track after each gap ("this also moves everything after 2:10"); switch_angle switches \
off pieces on the other angle tracks ("V1 and V3 are switched off from 1:00 to 1:10"); mute_track mutes the whole \
track ("this mutes all of A2"). Their clip ids must still be selected ones; use mute_track only on a track that has \
a selected clip.
- All times are seconds on the sequence timeline; in text to the user write them as m:ss, or h:mm:ss from \
one hour on (1:02:05, not 62:05).

Two kinds of instruction
1. A filler-word or pause trim ("trim the ums", "tighten the pauses"): call propose_filler_cuts with clear \
instructions, as your only tool call. It needs no plan; it ends the run and opens Genius Cut's trim review.
2. A timeline edit (markers, cuts, deletes, splits, moves, gaps, angles, on/off, volume, mutes, transitions, \
speed): plan first, then act after approval.
If an instruction mixes a trim with other edits, do the trim first: your plan says the trim runs now and asks \
the user to send the other edits afterwards as a new instruction; after approval call propose_filler_cuts.

Plan step (before approval)
- Edit tools are refused until the user approves ("Not approved yet"). Use the read tools (get_sequence first) \
to work out exactly what to do, then reply with the plan and no tool call.
- The plan is a short numbered list, one line per change, plain words, with times and clip/track names. \
Name anything that reaches beyond the selection ("this also moves …"). Don't ask questions unless the \
instruction can't be done.
- cut_ranges, move_clips and close_gaps rebuild clips from their source and drop their effects. When they \
touch clips whose get_sequence `effects` aren't empty, the plan must say "effects will be lost on <clips>" \
(naming them); only after the user approved that plan, pass acceptEffectLoss: true (cut_ranges, move_clips, \
close_gaps). Never pass it otherwise.
- Rebuilt that way, a clip's clip volume, Motion and Opacity settings are reset to the source's (keyframes too). \
When the plan cuts or moves clips, the plan must say "volume, Motion and Opacity settings will be reset on <clips>". \
If the same plan sets a volume, set it after the cuts and moves. cut_ranges also adds a short (2-frame) audio \
crossfade at every cut in the audio by itself; say so in the plan line for the cut ("with a short crossfade at the \
audio join").
- Genius Cut's Undo can't take a transition off (Premiere has no script call for it): when you add a \
transition, the plan must say so ("Undo won't remove the transition; remove it by hand").
- set_speed keeps each clip's place and length; choose a clip's own sound with its picture so they stay in sync.

After "Approved: do exactly this plan."
- Do exactly the plan: nothing more, nothing less. Call get_sequence again after each edit, because clip ids \
change. If a tool refuses, stop and say what happened.
- Finish with one or two plain sentences saying what was done. The user has an Undo button for the whole run; \
don't offer to undo."""


class RunError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


@dataclass
class Run:
    id: str
    client: object
    messages: list = field(default_factory=list)
    approved: bool = False
    steps: int = 0
    waiting: list[str] = field(default_factory=list)  # tool_use ids the panel must answer
    plan_ready: bool = False
    last_usage: tuple[int, int] | None = None  # (all input incl. cache, output) of the last step
    meter: spend.Meter = field(default_factory=lambda: spend.Meter(kind="agent"))
    lock: threading.Lock = field(default_factory=threading.Lock)


def _input_total(usage) -> int:
    return sum(int(getattr(usage, n, 0) or 0)
               for n in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))


class Runs:
    """Agent runs in memory, keyed by id."""

    def __init__(self, make_client: Callable = claude.default_client, step: Callable = claude.agent_step):
        self.make_client, self.step = make_client, step
        self._runs: dict[str, Run] = {}
        self._lock = threading.Lock()

    # ── public ─────────────────────────────────────────────────────

    def start(self, instruction: str, selection, sequence) -> dict:
        run_id = uuid.uuid4().hex
        try:
            client = self.make_client()  # reads the key once for the whole run
        except secrets.MissingKeyError as e:
            return self._stopped(Run(id=run_id, client=None), "key", str(e))
        except LLMError as e:
            return self._stopped(Run(id=run_id, client=None), "error", str(e))
        run = Run(id=run_id, client=client)
        first = (f"Instruction: {instruction.strip()}\n\n"
                 f"Selected clips (snapshot taken when the instruction was sent):\n{json.dumps(selection)}\n\n"
                 f"Sequence summary:\n{json.dumps(sequence)}")
        run.messages.append({"role": "user", "content": first})
        with self._lock:
            self._runs[run_id] = run
        with run.lock:
            return self._step(run, 0)

    def results(self, run_id: str, results: list[dict]) -> dict:
        run = self._get(run_id)
        with self._busy(run):
            if not run.waiting:
                raise RunError(409, "This run isn't waiting for tool results.")
            given = [r["tool_use_id"] for r in results]
            missing = [i for i in run.waiting if i not in given]
            extra = [i for i in given if i not in run.waiting]
            dupes = sorted({i for i in given if given.count(i) > 1})
            if missing or extra or dupes:
                raise RunError(422, "Send exactly one result per tool call. "
                               + "; ".join(p for p in (f"missing: {', '.join(missing)}" if missing else "",
                                                       f"unknown: {', '.join(extra)}" if extra else "",
                                                       f"repeated: {', '.join(dupes)}" if dupes else "") if p))
            by_id = {r["tool_use_id"]: r for r in results}
            blocks = [{"type": "tool_result", "tool_use_id": i, "content": by_id[i]["content"],
                       "is_error": bool(by_id[i].get("is_error", False))} for i in run.waiting]
            run.messages.append({"role": "user", "content": blocks})
            run.waiting = []
            return self._step(run, sum(len(b["content"]) for b in blocks))

    def approve(self, run_id: str) -> dict:
        run = self._get(run_id)
        with self._busy(run):
            if not run.plan_ready or run.approved:
                raise RunError(409, "There is no plan waiting for Go in this run.")
            run.approved, run.plan_ready = True, False
            run.messages.append({"role": "user", "content": APPROVED})
            return self._step(run, len(APPROVED))

    def cancel(self, run_id: str) -> None:
        with self._lock:
            self._runs.pop(run_id, None)

    # ── internals ──────────────────────────────────────────────────

    def _get(self, run_id: str) -> Run:
        with self._lock:
            run = self._runs.get(run_id)
        if run is None:
            raise RunError(404, LOST)
        return run

    @contextmanager
    def _busy(self, run: Run):
        if not run.lock.acquire(blocking=False):
            raise RunError(409, "This run is already working on a step.")
        try:
            yield
        finally:
            run.lock.release()

    def _estimate(self, run: Run, new_chars: int) -> int:
        if run.last_usage is None:  # first step: everything is new
            text = SYSTEM + json.dumps(TOOLS) + json.dumps(run.messages, default=str)
            return math.ceil(len(text) / spend.CHARS_PER_TOKEN)
        return spend.estimate_step(run.last_usage[0], run.last_usage[1], new_chars)

    def _step(self, run: Run, new_chars: int) -> dict:
        if run.steps >= MAX_STEPS:
            return self._stopped(run, "step_cap", f"Stopped after {MAX_STEPS} Claude steps without finishing. "
                                                  "What ran so far can be undone; try a smaller instruction.")
        try:
            with spend.meter(kind="agent", run=run.id, m=run.meter):
                response = self.step(run.messages, TOOLS, SYSTEM, client=run.client,
                                     input_tokens=self._estimate(run, new_chars))
        except spend.BudgetExceeded as e:
            return self._stopped(run, "limit", str(e))
        except (secrets.MissingKeyError, claude.KeyRejected) as e:
            return self._stopped(run, "key", str(e))
        except LLMError as e:
            return self._stopped(run, "error", str(e))
        run.steps += 1
        usage = getattr(response, "usage", None)
        if usage is not None:
            run.last_usage = (_input_total(usage), int(getattr(usage, "output_tokens", 0) or 0))
        stop = getattr(response, "stop_reason", None)
        if stop == "refusal":  # not appended: the run ends here
            details = getattr(response, "stop_details", None)
            category = getattr(details, "category", None)
            return self._stopped(run, "refusal", "Claude declined this instruction"
                                 + (f" ({category})." if category else "."))
        if stop == "max_tokens":  # a cut-off tool call must never run
            return self._stopped(run, "max_tokens", "Claude's reply was cut off, so nothing from it was run. "
                                                    "Try a smaller instruction.")
        run.messages.append({"role": "assistant", "content": response.content})  # whole, never edited
        text = "".join(getattr(b, "text", "") for b in response.content if getattr(b, "type", None) == "text")
        calls = [{"id": b.id, "name": b.name, "input": b.input}
                 for b in response.content if getattr(b, "type", None) == "tool_use"]
        if stop == "tool_use" and calls:
            run.waiting = [c["id"] for c in calls]
            if any(TOOL_KINDS.get(c["name"]) == "terminal" for c in calls):
                self.cancel(run.id)  # propose_filler_cuts ends the run; the panel opens the review
            return self._reply(run, "tool_calls", text=text, tool_calls=calls)
        if run.approved:
            self.cancel(run.id)
            return self._reply(run, "done", text=text)
        run.plan_ready = True
        return self._reply(run, "plan", text=text)

    def _stopped(self, run: Run, reason: str, message: str) -> dict:
        self.cancel(run.id)
        return self._reply(run, "stopped", message=message, reason=reason)

    def _reply(self, run: Run, state: str, *, text: str = "", tool_calls: list | None = None,
               message: str | None = None, reason: str | None = None) -> dict:
        return {"run_id": run.id, "state": state, "tool_calls": tool_calls or [], "text": text,
                "message": message, "reason": reason, "cost": llm.run_cost(run.meter).model_dump()}
