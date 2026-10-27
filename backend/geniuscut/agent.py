"""One instruction run on the selected AI model: the panel drives the tools, the backend owns the model.

HTTP routes (all need `Authorization: Bearer <token>`; errors are `{"detail": "..."}`):
- `POST /agent/runs` `{"instruction": str (not blank), "selection": object, "sequence": object,
  "projectPath"?: str, "timebase"?: str|int, "fps"?: number|str, "width"?: int, "height"?: int}`
  → step reply. `selection` is the selection snapshot taken when the instruction was sent (clip ids,
  span…), `sequence` a summary of the active sequence; both are passed to Claude as JSON. The optional
  graphics fields are `app.project.path` ("" = unsaved), the sequence's timebase (ticks per frame; or fps)
  and frame size; only make_graphic uses them (it refuses an unsaved project or another size).
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
  "cost": {"model": <catalog id>, "label": str, "provider": str, "input_tokens": int, "output_tokens": int,
           "usd": float|null, "month_usd": float, "limit_usd": float},  # usd = this run's total so far
  "graphics": [{"slug": str, "version": int, "preview": str, "path": str, "duration_s": float}]}
                                         # newest version of every graphic made in this run (preview = PNG path)
  reason also "graphics" (a graphic failed 3 times) and "cancelled" (DELETE while a step was working).
- `tool_calls`: run them (act tools before approval answer "Not approved yet: describe the plan
  instead" with is_error true) and post the results.
- `plan`: Claude's plan (text) before approval; show Go / Cancel. Go = approve.
- `done`: the approved run finished; text is Claude's summary. The run is closed.
- `stopped`: the run is closed; show `message` (for `limit`, the exact limit message).
- Backend tools (TOOL_KINDS "backend": search_envato, make_graphic, read_graphic) run here before the reply;
  they never appear in `tool_calls` and the panel never answers them. A reply with only backend tools
  steps again at once (counted toward the cap); with panel tools too, `tool_calls` holds only the panel
  ones and, when their results come, every result goes to Claude in the reply's tool_use order. Every
  search_envato of a reply runs in that step (side by side); then make_graphic / read_graphic in order. One
  make_graphic per reply (a second gets an error result); per slug, the third failed make_graphic stops
  the run. DELETE sets the run's cancel event: a running render is killed and no Claude call follows.
- `propose_filler_cuts` is terminal: a `tool_calls` reply containing it closes the run on the
  backend. The panel runs today's Analyse with its `instructions` and opens the review; it posts no
  results.

Rules (spec "Run rules → Agent loop" and "Runs"): a run resolves the selected model ONCE at its start (the
picker's settings.model, or a dev env override, see llm.selected_id) and keeps its catalog id, adapter and
client to the end: a switch in the picker applies to the next run only. The loop speaks the neutral step
contract in adapters.py; the adapter owns the conversation (append-only, model turns appended whole,
thinking included; never edited) and the id → tool name map. A refusal or a reply cut off at max_tokens
ends the run and is not appended or executed; at most MAX_STEPS (40) model calls per run, backend-only
steps included; every step goes through the
spend gate, estimated from the previous step's actual usage plus the new content; the client (and so the
key read) is made once per run. Texts name the model by its catalog label. Runs live in memory: a
backend restart loses them.

B-roll markers: `search_envato {searchTerms, kind: stock-video|photos, orientation?}` is a backend tool on
every provider: envato.py calls Envato's MCP server itself and the result text lists the titles and item_urls.
GENIUSCUT_ENVATO=0 takes the tool out of the run (ENVATO_OFF in the system prompt). A failed search returns
an error result and sets the run's Envato-down flag: from then on the system prompt carries ENVATO_DOWN
(give search terms only) and further searches in the run fail at once without calling Envato.
"""

import json
import math
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Callable

from geniuscut import adapters, catalog, claude, envato, gemini, graphics, llm, secrets, spend
from geniuscut.errors import LLMError

MAX_STEPS = 40  # model calls per run, backend-only steps included
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
            "and markers overlapping that stretch. On a long sequence, a call without fromS/toS lists only the "
            "stretch around the selection (no clips when nothing is selected) and says so in `listed`."),
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
        "name": "search_envato",
        "description": (
            "Search Envato Elements for B-roll (runs in the backend, read-only, no approval needed): the best "
            f"{envato.PER_PAGE} matches as title, author and item_url. kind stock-video searches Stock Footage, "
            "photos searches photos. Make every search of the run in one reply (several search_envato calls side "
            "by side): they all run together."),
        "input_schema": {
            "type": "object",
            "properties": {
                "searchTerms": {"type": "string", "minLength": 1, "maxLength": envato.MAX_TERMS,
                                "description": "Short and visual: what would be on screen (e.g. 'typing on "
                                               "laptop close up')."},
                "kind": {"type": "string", "enum": list(envato.KINDS),
                         "description": "stock-video (the default for B-roll) or photos (only when asked)."},
                "orientation": {"type": "string", "enum": list(envato.ORIENTATIONS),
                                "description": "horizontal unless the user asks for vertical."},
            },
            "required": ["searchTerms", "kind"],
            "additionalProperties": False,
        },
    },
    {
        "name": "make_graphic",
        "description": (
            "Write and render a motion graphic (runs in the backend, no timeline change, allowed before and after "
            "approval). html is a whole HyperFrames composition (start from read_graphic \"starter-<kind>\"); the "
            "backend saves it as the next version <project folder>/Genius Cut Graphics/<slug>/v<N>/, sets the root's "
            "size, frame rate and data-duration (elements that ran the old full length follow duration_s), runs "
            "HyperFrames' check, renders a transparent MOV at the sequence's frame rate and size, and a preview frame "
            "at previewAtS (default 40 % in, at most 1.5 s). Returns {slug, version, path, preview, duration_s, "
            "renderSeconds, warnings}, or the check / render errors to fix. One make_graphic per reply. A rendered "
            "graphic is placed only by place_graphic (or replace_graphic) after approval."),
        "input_schema": {
            "type": "object",
            "properties": {
                "slug": {"type": "string", "pattern": "^[a-z0-9]+(-[a-z0-9]+)*$", "maxLength": 40,
                         "description": "Short lowercase name, hyphens between words (\"mfa-lower-third\"). The same "
                                        "slug makes a new version of that graphic."},
                "kind": {"type": "string", "enum": list(graphics.KINDS), "description": "Which kind of graphic."},
                "duration_s": {"type": "number", "minimum": graphics.MIN_DURATION_S,
                               "maximum": graphics.MAX_DURATION_S, "description": "Its length in seconds."},
                "html": {"type": "string", "minLength": 1, "description": "The whole composition HTML."},
                "variables": {"type": "object", "additionalProperties": {"type": ["string", "number", "boolean"]},
                              "description": "Optional values for the composition's declared variables, by id."},
                "previewAtS": {"type": "number", "minimum": 0,
                               "description": "Optional: where the preview frame is taken, seconds from the "
                                              "graphic's start (pick the moment it reads best)."},
            },
            "required": ["slug", "kind", "duration_s", "html"],
            "additionalProperties": False,
        },
    },
    {
        "name": "read_graphic",
        "description": (
            "Read a graphic's newest version (runs in the backend): {slug, kind, version, versions, duration_s, "
            "variables, path, preview, html}. \"starter-lower-third\", \"starter-callout\", \"starter-card\" and "
            "\"starter-explainer-scene\" return the itGenius starter for that kind ({slug, starter, kind, html})."),
        "input_schema": {
            "type": "object",
            "properties": {"slug": {"type": "string", "minLength": 1,
                                    "description": "The graphic's slug, or starter-<kind>."}},
            "required": ["slug"],
            "additionalProperties": False,
        },
    },
    {
        "name": "place_graphic",
        "description": (
            "Put a rendered graphic (the path make_graphic returned) on the timeline at atS: it is imported into the "
            "\"Genius Cut Graphics\" bin and laid on the lowest video track above the selection's tracks that is "
            "empty over its whole length. Refused if no such track is free (\"add a video track\") or atS is "
            "outside the selected clips' span. Returns newIds: [the laid clip's id]. " + _SECONDS + " " + _UNDO),
        "input_schema": {
            "type": "object",
            "properties": {
                "sequenceId": _SEQ_ID,
                "path": {"type": "string", "minLength": 1, "description": "The MOV path make_graphic returned."},
                "atS": {"type": "number", "minimum": 0, "description": "Where the graphic starts. " + _SECONDS},
            },
            "required": ["sequenceId", "path", "atS"],
            "additionalProperties": False,
        },
    },
    {
        "name": "replace_graphic",
        "description": (
            "Swap a placed graphic clip for another version (the path make_graphic returned): the new version starts "
            "at the same time on the same track with its own length; refused if anything is in the way of the new "
            "length. Returns idMap {old id: [new id]}. " + _STALE + " " + _UNDO),
        "input_schema": {
            "type": "object",
            "properties": {
                "sequenceId": _SEQ_ID,
                "clipId": {"type": "string", "description": "The placed graphic clip, its id from get_sequence. " + _STALE},
                "path": {"type": "string", "minLength": 1, "description": "The new version's MOV path."},
            },
            "required": ["sequenceId", "clipId", "path"],
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

# read: any time; act: only after approval (the panel enforces); terminal: ends the run; backend: run here, in
# the agent loop (never sent to the panel), any time.
TOOL_KINDS = {"get_sequence": "read", "get_transcript": "read", "wait_transcript": "read",
              "add_markers": "act", "cut_ranges": "act", "delete_clips": "act", "close_gaps": "act", "split_at": "act",
              "set_clip_enabled": "act", "move_clips": "act", "switch_angle": "act", "set_volume": "act",
              "mute_track": "act", "add_transition": "act", "set_speed": "act",
              "search_envato": "backend", "make_graphic": "backend", "read_graphic": "backend",
              "place_graphic": "act", "replace_graphic": "act",
              "propose_filler_cuts": "terminal"}

MAX_GRAPHIC_FAILURES = 3  # per slug per run: the third failed make_graphic ends the run
ONE_GRAPHIC = "One graphic per reply: make the next one after this result."

BROLL_COLOUR = 7  # Premiere's marker colour index 7 (Cyan), reserved for B-roll markers

ENVATO_OFF = ("Envato search is switched off in this run: for B-roll, give the search terms to use for each spot "
              "instead of Envato clips, and put only the search terms in the marker comments.")
ENVATO_DOWN = ("Envato search is unavailable right now (the Envato server couldn't be reached): for B-roll, give the "
               "search terms to use for each spot instead of Envato clips, and put only the search terms in the "
               "marker comments.")
ENVATO_FAILED = ("Envato search failed ({why}). Envato is unavailable for the rest of this run: give the search "
                 "terms only for B-roll, in the plan and in the marker comments.")
SEARCHES_AT_ONCE = 6  # search_envato calls of one reply run side by side, this many at a time

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
2. A timeline edit (markers, B-roll markers, cuts, deletes, splits, moves, gaps, angles, on/off, volume, mutes, transitions, \
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

B-roll markers ("mark B-roll spots", "where do I need B-roll?")
- A planned edit with add_markers. Read what is said in the selected clips (get_transcript, then wait_transcript \
if needed) and pick the spots that need B-roll: where the speaker names or describes something the viewer could \
see, lists things, or talks to camera for long. Each spot is a time range inside the selected clips.
- For each spot, search Envato Elements with search_envato: 1-3 phrasings per spot, searchTerms short and \
visual (what would be on screen, e.g. "typing on laptop close up", under 60 characters), kind "stock-video" and \
orientation "horizontal" unless the user asks for photos (kind "photos") or vertical. Make all of the run's \
searches in ONE reply, every search_envato call side by side: they run together, and each extra reply costs a \
step. search_envato is read-only and needs no approval.
- The plan lists each spot: its time range (m:ss-m:ss), the short idea, and the best 2-3 Envato clips by title \
with their item_url links.
- After approval, one add_markers call with one range marker per spot: atS and endS = the spot, name "B-roll: \
<short idea>", colour """ + str(BROLL_COLOUR) + """ (reserved for B-roll; don't use it for other markers), \
comments = "Search: <the search terms used>" and then each chosen clip as "<title> - <item_url>", one per line.
- Never download or place clips: B-roll is markers only. If an Envato search errors or Envato is unavailable, \
the plan gives the search terms only and the comments hold just the search terms.

Motion graphics ("lower third 'Turn on MFA' when I say MFA", "a card listing SPF, DKIM, DMARC for 6 seconds")
- Four kinds: lower-third (name / title bar), callout (kinetic text popping up at a spot), card (full-screen \
list, numbered steps, two-column comparison or a simple bar chart), explainer-scene (icons, shapes and labels \
animating in sequence to the narration).
- Graphics are made and rendered during the plan, before approval: read the starter for the kind \
(read_graphic "starter-<kind>"), adapt it (text, variables, layout, timing) or go beyond it for explainer scenes, \
then make_graphic. One make_graphic per reply: wait for its result before the next. If it returns check or \
render errors, fix the HTML and call it again; after """ + str(MAX_GRAPHIC_FAILURES) + """ failures of one graphic \
the run stops.
- Timing from the transcript: get_transcript (then wait_transcript) for the selected clips, and use the word \
times: a graphic starts (atS) just before its words are spoken and lasts until they are done (a lower third at \
least 4 s). In callouts and explainer scenes, time each beat to its words (seconds from the graphic's start).
- The composition contract: keep the starter's head (assets/tokens.css, assets/gsap.min.js, the inline @font-face \
for assets/fonts/Outfit-Variable.ttf) and its root <div id="root" data-composition-id="main">; one paused GSAP \
timeline registered as window.__timelines["main"]; timed elements carry class="clip", data-start and \
data-duration; author at 1920x1080 (1080x1920 for a vertical sequence; a 4K sequence renders the same layout at \
twice the pixels). Only files under assets/ (fonts, gsap.min.js, tokens.css, icons/*.svg): no web fonts, CDNs \
or network, no Math.random or Date.now, no <audio> or <video>. Don't tween a .clip's visibility or autoAlpha; \
animate its children.
- itGenius style: Deep Navy #112A33 panels, Blue #009BD0 (the angled-edge wedge), Coral #FF7A51 for one \
highlight, Soft Rose #D06F9B sparingly, White #FFFFFF text, Light Grey #F8F9FB light cards; Outfit only (Bold \
headlines, Light body); the angled edge; at most two accent colours in a frame; 120 px safe margins; text at least \
30 px; entries 0.4-0.6 s ease-out (power3.out); every graphic animates out before its end. Clean flat shapes: no \
scribbles, hand-drawn marks or emoji.
- Full screen means the whole frame: a card or explainer scene has a solid Deep Navy background filling the frame \
edge to edge (position absolute, inset 0, no clip-path or margin at rest), so no video shows through anywhere \
between its entry and its exit. The angled-edge wedge may appear as a decorative accent inside it, never as the \
frame's outline. Only lower thirds and callouts leave the video showing around them.
- Legible on a phone (sizes at 1080p; a vertical sequence uses the same pixel sizes): on a card or explainer scene \
the title is at least 64 px and every label, item and body line at least 34 px, and explainer icons are at least \
96 px; nothing anywhere is under 30 px. Fewer words beat smaller text: shorten a label rather than shrink it.
- Before each make_graphic, check your own HTML against these rules: a full-screen kind's background covers the \
whole frame, and every font-size, and every icon's width and height, meets the minimums above. Fix it first if not.
- The plan lists each graphic on its own line: what it says, its slug, its length and where it goes ("lower third \
'Turn on MFA', 4 s at 1:12 (preview above)"). The panel shows each graphic's preview frame with the plan.
- After approval, place each graphic with place_graphic at its time (the path make_graphic returned). It goes on \
the lowest free video track above the selection; if it is refused because no track is free, stop and say "add a \
video track above the clips".
- Editing a placed graphic ("make it slower", "make the bar coral"): the user selects the graphic clip. Its \
get_sequence source is ".../Genius Cut Graphics/<slug>/v<N>/<slug>.mov": read_graphic that slug, make_graphic \
the same slug with the change (a new version; earlier ones are kept), plan "replace <slug> v<N> with v<N+1>", \
and after approval replace_graphic with the selected clip's id and the new path.

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
    model_id: str = catalog.DEFAULT_MODEL  # the catalog id this run uses from start to end
    adapter: object = None                 # adapters.for_entry(...): owns the conversation history
    approved: bool = False
    steps: int = 0
    waiting: list[str] = field(default_factory=list)  # tool_use ids the panel must answer
    plan_ready: bool = False
    envato: bool = False  # search_envato is offered in this run (GENIUSCUT_ENVATO not 0)
    envato_down: bool = False  # a search failed: the rest of the run gives search terms only
    envato_note: str = ""  # what the model is told when Envato is off or down (ENVATO_OFF / ENVATO_DOWN)
    last_usage: tuple[int, int] | None = None  # (all input incl. cache, output) of the last step
    meter: spend.Meter = field(default_factory=lambda: spend.Meter(kind="agent"))
    lock: threading.Lock = field(default_factory=threading.Lock)
    # graphics: the run's project and sequence (from the panel), what was made, failures per slug
    project_path: str = ""
    fps: float | str | None = None
    timebase: str | None = None
    width: int | None = None
    height: int | None = None
    graphics: dict = field(default_factory=dict)  # slug → {slug, version, preview, path, duration_s} (newest)
    failures: dict = field(default_factory=dict)  # slug → failed make_graphic calls
    order: list[str] = field(default_factory=list)  # every tool call id of the last reply, in order
    pending: dict = field(default_factory=dict)  # tool call id → backend ToolResult, until the panel posts
    cancelled: bool = False
    cancel_event: threading.Event = field(default_factory=threading.Event)

    @property
    def messages(self) -> list:
        """The conversation as the adapter keeps it (provider-shaped; read-only here)."""
        return self.adapter.history if self.adapter is not None else []

    @property
    def tools(self) -> list[dict]:
        """The tools this run offers: TOOLS, without search_envato when Envato is switched off."""
        return TOOLS if self.envato else [t for t in TOOLS if t["name"] != "search_envato"]

    @property
    def label(self) -> str:
        return catalog.label(self.model_id) or self.model_id


class GraphicsStop(Exception):
    """A graphic failed MAX_GRAPHIC_FAILURES times: the run ends with this message."""


class Runs:
    """Agent runs in memory, keyed by id. Each run resolves the selected model once at its start
    (`selected()`, default llm.selected_id: the picker or a dev override) and keeps it, its adapter and its
    client to the end. `make_client` (tests) replaces the adapter's own client factory; `envato_search(kind,
    terms, orientation)` (tests) replaces envato.search."""

    def __init__(self, make_client: Callable | None = None, engine: graphics.Engine | None = None, *,
                 selected: Callable[[], str] | None = None, adapter_for: Callable = adapters.for_entry,
                 envato_search: Callable = envato.search):
        self.make_client, self.adapter_for, self.envato_search = make_client, adapter_for, envato_search
        self.selected = selected or llm.selected_id
        self.engine = engine or graphics.Engine()
        self._runs: dict[str, Run] = {}
        self._lock = threading.Lock()

    # ── public ─────────────────────────────────────────────────────

    def start(self, instruction: str, selection, sequence, context: dict | None = None) -> dict:
        """`context` (all optional): {projectPath, fps, timebase, width, height} of the open project and sequence,
        used only by make_graphic."""
        run_id = uuid.uuid4().hex
        try:
            entry = catalog.entry_for(self.selected())  # the run's model, kept to the end
            adapter = self.adapter_for(entry)
        except LLMError as e:
            return self._stopped(Run(id=run_id, client=None), "error", str(e))
        bare = Run(id=run_id, client=None, model_id=entry.id)
        try:
            client = (self.make_client or adapter.make_client)()  # reads the key once for the whole run
        except secrets.MissingKeyError as e:
            return self._stopped(bare, "key", str(e))
        except LLMError as e:
            return self._stopped(bare, "error", str(e))
        on = envato.enabled()  # search_envato on every provider unless GENIUSCUT_ENVATO=0
        ctx = context or {}
        run = Run(id=run_id, client=client, model_id=entry.id, adapter=adapter, envato=on,
                  envato_note="" if on else ENVATO_OFF,
                  project_path=str(ctx.get("projectPath") or ""), fps=ctx.get("fps"),
                  timebase=str(ctx["timebase"]) if ctx.get("timebase") not in (None, "") else None,
                  width=ctx.get("width"), height=ctx.get("height"))
        first = (f"Instruction: {instruction.strip()}\n\n"
                 f"Selected clips (snapshot taken when the instruction was sent):\n{json.dumps(selection)}\n\n"
                 f"Sequence summary:\n{json.dumps(sequence)}")
        if any(ctx.get(k) not in (None, "") for k in ("projectPath", "fps", "timebase", "width", "height")):
            first += "\n\nFor graphics: " + _graphics_context(run)
        adapter.add_user_text(first)
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
            panel = {i: adapters.ToolResult(i, by_id[i]["content"], bool(by_id[i].get("is_error", False)))
                     for i in run.waiting}
            # one turn with every result, in the reply's tool call order (backend ones ran already)
            done = {**run.pending, **panel}
            ordered = [done[i] for i in run.order if i in done]
            run.adapter.add_tool_results(ordered)
            run.waiting, run.pending, run.order = [], {}, []
            return self._step(run, sum(len(r.content) for r in ordered))

    def approve(self, run_id: str) -> dict:
        run = self._get(run_id)
        with self._busy(run):
            if not run.plan_ready or run.approved:
                raise RunError(409, "There is no plan waiting for Go in this run.")
            run.approved, run.plan_ready = True, False
            run.adapter.add_user_text(APPROVED)
            return self._step(run, len(APPROVED))

    def cancel(self, run_id: str) -> None:
        """Forget the run; a step still working sees `cancelled` (no further Claude call or render) and a
        running render is killed through the run's cancel event."""
        with self._lock:
            run = self._runs.pop(run_id, None)
        if run is not None:
            run.cancelled = True
            run.cancel_event.set()

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
            text = SYSTEM + json.dumps(run.tools) + json.dumps(run.messages, default=str)
            return math.ceil(len(text) / spend.CHARS_PER_TOKEN)
        return spend.estimate_step(run.last_usage[0], run.last_usage[1], new_chars)

    def _step(self, run: Run, new_chars: int) -> dict:
        if run.cancelled:
            return self._reply(run, "stopped", message="Cancelled.", reason="cancelled")
        if run.steps >= MAX_STEPS:
            return self._step_cap(run)
        try:
            step = self._call(run, new_chars)
        except adapters.OutOfSteps:
            run.steps = MAX_STEPS
            return self._step_cap(run)
        except spend.BudgetExceeded as e:
            return self._stopped(run, "limit", str(e))
        except (secrets.MissingKeyError, claude.KeyRejected, gemini.KeyRejected) as e:
            return self._stopped(run, "key", str(e))
        except LLMError as e:
            return self._stopped(run, "error", str(e))
        run.steps += step.requests
        if step.usage is not None:
            run.last_usage = (step.usage.input, step.usage.output)
        if step.stop == "refusal":  # not appended (the adapter keeps refused replies out): the run ends here
            return self._stopped(run, "refusal", f"{run.label} declined this instruction"
                                 + (f" ({step.detail})." if step.detail else "."))
        if step.stop == "max_tokens":  # a cut-off tool call must never run
            return self._stopped(run, "max_tokens", f"{run.label}'s reply was cut off, so nothing from it was run. "
                                                    "Try a smaller instruction.")
        if step.stop not in ("end", "tool_use"):
            return self._stopped(run, "error", f"{run.label} returned no usable reply"
                                 + (f": {step.detail}" if step.detail else "."))
        text, calls = step.text, step.tool_calls
        if step.stop == "tool_use" and calls:
            backend = [c for c in calls if TOOL_KINDS.get(c["name"]) == "backend"]
            panel = [c for c in calls if TOOL_KINDS.get(c["name"]) != "backend"]
            if backend:
                try:
                    done = self._run_backend(run, backend)
                except graphics.Cancelled:
                    return self._reply(run, "stopped", message="Cancelled.", reason="cancelled")
                except GraphicsStop as e:
                    return self._stopped(run, "graphics", str(e))
                if run.cancelled:
                    return self._reply(run, "stopped", message="Cancelled.", reason="cancelled")
                if not panel:  # only backend tools: step again, no panel round trip
                    run.adapter.add_tool_results([done[c["id"]] for c in backend])
                    return self._step(run, sum(len(r.content) for r in done.values()))
                run.pending = done
            run.order = [c["id"] for c in calls]
            run.waiting = [c["id"] for c in panel]
            if any(TOOL_KINDS.get(c["name"]) == "terminal" for c in panel):
                self.cancel(run.id)  # propose_filler_cuts ends the run; the panel opens the review
            return self._reply(run, "tool_calls", text=text, tool_calls=panel)
        if run.approved:
            self.cancel(run.id)
            return self._reply(run, "done", text=text)
        run.plan_ready = True
        return self._reply(run, "plan", text=text)

    def _run_backend(self, run: Run, calls: list[dict]) -> dict:
        """Every search_envato side by side, then make_graphic / read_graphic in order; {tool call id: ToolResult}."""
        searches = [c for c in calls if c["name"] == "search_envato"]
        done = self._search_envato(run, searches) if searches else {}
        made = False
        for c in calls:
            if c["name"] == "search_envato":
                continue
            if run.cancelled:
                raise graphics.Cancelled()
            if c["name"] == "make_graphic":
                if made:
                    content, err = ONE_GRAPHIC, True
                else:
                    made = True
                    content, err = self._make_graphic(run, c["input"] or {})
            else:
                content, err = self._read_graphic(run, c["input"] or {})
            done[c["id"]] = adapters.ToolResult(c["id"], content, err)
        return done

    def _search_envato(self, run: Run, calls: list[dict]) -> dict:
        """Run a reply's searches together (at most SEARCHES_AT_ONCE at a time); a failure sets the run's
        Envato-down flag, after which searches fail at once."""
        def one(c) -> adapters.ToolResult:
            inp = c["input"] if isinstance(c["input"], dict) else {}
            if not run.envato:
                return adapters.ToolResult(c["id"], ENVATO_OFF, True)
            try:
                envato.request_for(inp.get("kind"), inp.get("searchTerms"), inp.get("orientation"))
            except ValueError as e:  # the model's mistake, not Envato's: no flag
                return adapters.ToolResult(c["id"], f"search_envato: {e}.", True)
            if run.envato_down:
                return adapters.ToolResult(c["id"], ENVATO_FAILED.format(why="it failed earlier in this run"), True)
            terms = inp["searchTerms"].strip()
            try:
                found = self.envato_search(inp["kind"], terms, inp.get("orientation"))
            except Exception as e:  # noqa: BLE001 - any failure is "Envato down", never a crashed run
                run.envato_down, run.envato_note = True, ENVATO_DOWN
                why = str(e) if isinstance(e, envato.EnvatoError) else "an unexpected error"
                return adapters.ToolResult(c["id"], ENVATO_FAILED.format(why=why), True)
            return adapters.ToolResult(c["id"], _envato_text(terms, found), False)

        if len(calls) == 1:
            r = one(calls[0])
            return {r.id: r}
        with ThreadPoolExecutor(max_workers=min(SEARCHES_AT_ONCE, len(calls))) as pool:
            return {r.id: r for r in pool.map(one, calls)}

    def _make_graphic(self, run: Run, inp: dict) -> tuple[str, bool]:
        slug = str(inp.get("slug", ""))
        try:
            out = self.engine.make(project_path=run.project_path, slug=inp.get("slug"), kind=inp.get("kind"),
                                   duration_s=inp.get("duration_s"), html=inp.get("html"),
                                   variables=inp.get("variables"), preview_at_s=inp.get("previewAtS"),
                                   width=run.width, height=run.height, fps=run.fps, timebase=run.timebase,
                                   cancel=run.cancel_event)
        except graphics.Cancelled:
            raise
        except graphics.GraphicsError as e:
            failure = str(e)
        else:
            if out["ok"]:
                run.graphics[out["slug"]] = {k: out[k] for k in ("slug", "version", "preview", "path", "duration_s")}
                keep = ("slug", "version", "path", "preview", "duration_s", "renderSeconds", "warnings")
                return json.dumps({k: out[k] for k in keep}), False
            failure = f"HyperFrames {out['stage']} failed:\n" + "\n".join(out["errors"])
            if out.get("warnings"):
                failure += "\nWarnings:\n" + "\n".join(out["warnings"])
        run.failures[slug] = run.failures.get(slug, 0) + 1
        left = MAX_GRAPHIC_FAILURES - run.failures[slug]
        if left <= 0:
            raise GraphicsStop(f"The graphic \"{slug}\" failed {MAX_GRAPHIC_FAILURES} times, so the run stopped. "
                               f"Last error: {failure[:800]}")
        return (f"{failure}\n\nFix it and call make_graphic again; {left} more failure"
                f"{'s' if left > 1 else ''} of this graphic will stop the run."), True

    def _read_graphic(self, run: Run, inp: dict) -> tuple[str, bool]:
        try:
            return json.dumps(self.engine.read(run.project_path, inp.get("slug"))), False
        except graphics.GraphicsError as e:
            return str(e), True
        except OSError as e:
            return f"The graphic couldn't be read: {e}", True

    def _call(self, run: Run, new_chars: int) -> adapters.Step:
        system = SYSTEM + ("\n\n" + run.envato_note if run.envato_note else "")
        with spend.meter(kind="agent", run=run.id, m=run.meter):
            return run.adapter.step(system, run.tools, client=run.client,
                                    input_tokens=self._estimate(run, new_chars), max_requests=MAX_STEPS - run.steps)

    def _step_cap(self, run: Run) -> dict:
        return self._stopped(run, "step_cap", f"Stopped after {MAX_STEPS} {run.label} steps without finishing. "
                                              "What ran so far can be undone; try a smaller instruction.")

    def _stopped(self, run: Run, reason: str, message: str) -> dict:
        self.cancel(run.id)
        return self._reply(run, "stopped", message=message, reason=reason)

    def _reply(self, run: Run, state: str, *, text: str = "", tool_calls: list | None = None,
               message: str | None = None, reason: str | None = None) -> dict:
        return {"run_id": run.id, "state": state, "tool_calls": tool_calls or [], "text": text,
                "message": message, "reason": reason, "cost": llm.run_cost(run.meter, default=run.model_id).model_dump(),
                "graphics": list(run.graphics.values())}


def _envato_text(terms: str, found: list[dict]) -> str:
    if not found:
        return f'No Envato results for "{terms}": try other search terms, or give the search terms only.'
    lines = [f'Envato results for "{terms}":']
    for i, it in enumerate(found, 1):
        by = f" (by {it['author']})" if it.get("author") else ""
        lines.append(f"{i}. {it['title']}{by} - {it['item_url']}")
    return "\n".join(lines)


def _graphics_context(run: Run) -> str:
    if not run.project_path:
        where = "the project isn't saved (make_graphic will refuse: ask the user to save it first)"
    else:
        where = f"the project is {run.project_path}"
    try:
        rate = graphics.fps_arg(run.fps, run.timebase) + " fps"
    except (graphics.GraphicsError, ValueError, ZeroDivisionError):
        rate = "an unknown frame rate"
    size = f"{run.width}x{run.height}" if run.width and run.height else "an unknown size"
    return f"{where}; the sequence is {size} at {rate}."
