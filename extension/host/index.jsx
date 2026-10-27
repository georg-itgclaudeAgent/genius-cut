/*
 * Genius Cut — ExtendScript host (Premiere Pro). ES3: no JSON, let/const, arrows or Array extras.
 *
 * Every global is prefixed `gcut`: ExtendScript has one global namespace shared by every
 * CEP panel in Premiere (PR Extension included).
 *
 * Contract with the panel (extension/client/src/api/host.ts):
 *   - each gcut* function takes one JSON-encoded string argument and returns a JSON string;
 *   - failures return "Error: <message>" and never throw.
 *
 * Timeline edits rebuild every recorded clip (a selection snapshot taken at Analyse: the selected
 * video clips and the selected audio). The clips may start and end anywhere: the editor synced
 * them by hand, and audio may run past the video or the other way round. Cuts are timeline
 * moments: each recorded clip loses exactly the parts of the cut ranges that fall on it, and every
 * kept piece slides left by one shared mapping, t -> t - removedBefore(t), so the hand-made
 * offsets between the clips survive. Following plan decision D2 each clip is removed and its kept
 * pieces re-laid from its own source with overwriteClip, on its own track (no razor: an early probe
 * saw Premiere 2026 no-op the QE razor; measured 2026-10-14 it splits with an "HH:MM:SS:FF" timecode,
 * which split_at uses, checking every split). Consequences:
 *   - The rebuild lays fresh clips from the source, so effects, grades, keyframes and audio
 *     gain on the originals are NOT carried over. gcutSnapshotSelection names the effects on
 *     each clip so the panel can warn before Apply.
 *   - Apply is all-or-nothing: every piece is checked as it lands, and any failure puts every
 *     clip back at its own original place. The bin items' own in/out marks are always restored.
 *   - What it can't do safely is refused before anything changes: retimed clips, and a slide
 *     that would cover a clip it didn't record.
 *   - Restore puts every recorded clip back at its own place; Close gap slides every clip Apply
 *     didn't rebuild that starts inside or after the range by the same mapping, on every track.
 *     Both work from the record Apply keeps for this session only.
 *
 * Measured in Premiere 26.5.2 (2026-10-08), and relied on:
 *   - overwriteClip places a file's picture AND its sound, whichever kind of track it's called on:
 *     videoTrack[i] drops the clip's sound on audioTrack[i], and audioTrack[i] drops a video file's
 *     picture on videoTrack[i]. Track targeting doesn't change that. gcutLayAll orders the lays
 *     around it, gcutDropsCheck refuses what it would overwrite, and every track is checked after;
 *   - TrackItem.end sets a clip's length either way (its reported outPoint goes stale), and leaves
 *     the linked partner as it was; remove() leaves the linked partner too.
 *   - trackItem.move(Time) blocked Premiere forever once (2026-10-15, an assistant move of V3 Camera A by
 *     +3 s): the assistant's move tools never call it (they lay clips again). The panel's Close gap still
 *     uses it, as it always has.
 * Unverified (docs silent or contradictory):
 *   - setInPoint/setOutPoint units (docs say ticks for one, seconds for the other): set,
 *     read back, fall back to the other unit, and remember which worked;
 *   - whether move() moves the linked partner: handled either way (Close gap moves each item
 *     and checks every track after).
 */

var GCUT_TICKS = 254016000000; // Premiere ticks per second
var GCUT_ALL_MEDIA = 4;
var GCUT_VIDEO_INTRINSIC = { "Opacity": 1, "Motion": 1, "Time Remapping": 1, "Vector Motion": 1 };
var GCUT_AUDIO_INTRINSIC = { "Volume": 1, "Channel Volume": 1, "Panner": 1 };

// ── JSON (ExtendScript has none) ────────────────────────────────────────────────────

function gcutIsArray(v) { return Object.prototype.toString.call(v) === "[object Array]"; }

function gcutQuote(s) {
    var out = '"', c, code;
    for (var i = 0; i < s.length; i++) {
        c = s.charAt(i);
        code = s.charCodeAt(i);
        if (c === '"') out += '\\"';
        else if (c === "\\") out += "\\\\";
        else if (c === "\n") out += "\\n";
        else if (c === "\r") out += "\\r";
        else if (c === "\t") out += "\\t";
        else if (code < 0x20 || code === 0x2028 || code === 0x2029) out += "\\u" + ("0000" + code.toString(16)).slice(-4);
        else out += c;
    }
    return out + '"';
}

/** Like JSON.stringify: object keys whose value is undefined or a function are dropped. */
function gcutStringify(v) {
    if (v === null || v === undefined) return "null";
    var t = typeof v;
    if (t === "number") return isFinite(v) ? String(v) : "null";
    if (t === "boolean") return v ? "true" : "false";
    if (t === "string") return gcutQuote(v);
    var parts = [], k;
    if (gcutIsArray(v)) {
        for (k = 0; k < v.length; k++) parts.push(gcutStringify(v[k]));
        return "[" + parts.join(",") + "]";
    }
    for (k in v) {
        if (v.hasOwnProperty(k) && v[k] !== undefined && typeof v[k] !== "function") {
            parts.push(gcutQuote(k) + ":" + gcutStringify(v[k]));
        }
    }
    return "{" + parts.join(",") + "}";
}

/** json2-style: validate the text is pure JSON before eval'ing it. */
function gcutParse(text) {
    var safe = String(text)
        .replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, "@")
        .replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, "]")
        .replace(/(?:^|:|,)(?:\s*\[)+/g, "");
    if (!/^[\],:{}\s]*$/.test(safe)) throw new Error("Invalid JSON from the panel.");
    return eval("(" + text + ")");
}

function gcutOk(obj) { return gcutStringify(obj); }
function gcutFail(e) { return "Error: " + (e && e.message ? e.message : String(e)); }

// ── time: ticks end to end, whole frames for anything we place ──────────────────────

function gcutTimeFromTicks(ticks) { var t = new Time(); t.ticks = String(ticks); return t; }
function gcutT(time) { return Number(time.ticks); }

function gcutClock(seq) {
    var tpf = Number(seq.timebase);
    return { tpf: tpf, fps: GCUT_TICKS / tpf, frameS: tpf / GCUT_TICKS, half: tpf / 2 };
}

function gcutNear(a, b, tol) { return Math.abs(a - b) <= tol; }

// ── lookups ─────────────────────────────────────────────────────────────────────────

function gcutSequence() {
    if (!app.project) throw new Error("No project is open.");
    var seq = app.project.activeSequence;
    if (!seq) throw new Error("No active sequence. Open the sequence with the clip first.");
    return seq;
}

function gcutItems(track) {
    var list = [];
    for (var i = 0; i < track.clips.numItems; i++) list.push(track.clips[i]);
    return list;
}

function gcutTracks(seq) {
    var all = [], t;
    for (t = 0; t < seq.videoTracks.numTracks; t++) all.push({ track: seq.videoTracks[t], label: "V" + (t + 1), audio: false, index: t, t: all.length });
    for (t = 0; t < seq.audioTracks.numTracks; t++) all.push({ track: seq.audioTracks[t], label: "A" + (t + 1), audio: true, index: t, t: all.length });
    return all;
}

function gcutBaseName(name) { return String(name).replace(/\.[^.]*$/, "").toLowerCase(); }

function gcutNameMatches(itemName, wanted) {
    var a = String(itemName).toLowerCase(), b = String(wanted).toLowerCase();
    return a === b || gcutBaseName(a) === gcutBaseName(b);
}

function gcutSpeed(item) {
    var s = typeof item.getSpeed === "function" ? item.getSpeed() : 1;
    var reversed = typeof item.isSpeedReversed === "function" && item.isSpeedReversed() == 1;
    return reversed ? -Math.abs(s) : s;
}

function gcutNode(item) { return item.projectItem ? item.projectItem.nodeId : null; }

// A "frame rate" above this is an audio file's sample rate (48000), not frames.
var GCUT_MAX_FRAME_RATE = 1000;

/** The source media's frame rate as Premiere reports it, or 0 if it won't say. */
function gcutMediaFps(pi) {
    try {
        var fps = Number(pi.getFootageInterpretation().frameRate);
        if (fps > 0 && isFinite(fps)) return fps;
    } catch (e) { /* not available on this item */ }
    return 0;
}

/** The source media's frame rate, falling back to the sequence's if Premiere won't say. */
function gcutSourceFps(pi, clock) { return gcutMediaFps(pi) || clock.fps; }

/**
 * True if a source's frames coincide with the sequence's: EXACTLY the same rate, or an exact whole
 * multiple (29.97 = 30000/1001 in a 29.97 sequence). Premiere 26.5.2 (measured 2026-10-08) reports a
 * screen recording at 29.9950808 fps, and floors set points to THOSE frames: in a 30 fps sequence
 * that drifts a frame every few minutes, so it doesn't fit.
 */
function gcutFits(srcFps, clock) {
    var ratio = srcFps / clock.fps;
    return Math.round(ratio) >= 1 && Math.abs(ratio - Math.round(ratio)) < 1e-5;
}

/**
 * A loose clip's true source in point, from the one Premiere reports. Premiere 26.5.2 (measured)
 * reports a track item's in point floored to the SEQUENCE's frames, but the clip really starts on
 * one of its own frames (where Premiere floored the set point), in [reported, reported + a sequence
 * frame). Re-laying from the reported value would floor again and slip a frame earlier on every
 * Apply or Restore. Takes the EARLIEST own frame at or after the reported value: exact when the
 * clip's own frames are longer than the sequence's (only one of them fits there), and when the in
 * point sits on both grids (a 59.94 clip from 0 in 30); otherwise still a fixed point, so it never
 * drifts. (The latest own frame that fits drifted later every cycle when own frames are shorter.)
 */
function gcutTrueInS(reportedS, ownFrameS, seqFrameS) {
    var own = Math.ceil(reportedS / ownFrameS - 1e-6) * ownFrameS;
    return own < reportedS + seqFrameS - 1e-9 ? own : reportedS;
}

function gcutEffects(item, intrinsic, out) {
    if (!item || !item.components) return;
    for (var i = 0; i < item.components.numItems; i++) {
        var name = item.components[i].displayName;
        if (!intrinsic[name]) {
            var dup = false;
            for (var j = 0; j < out.length; j++) if (out[j] === name) dup = true;
            if (!dup) out.push(name);
        }
    }
}

// ── setting source in/out, whichever unit this Premiere build wants ─────────────────

if (typeof $ !== "undefined" && $.global && !$.global.gcutStash) $.global.gcutStash = {};
function gcutState() { return $.global; }

function gcutTrySet(pi, which, seconds, unit) {
    var setter = which === "in" ? "setInPoint" : "setOutPoint";
    pi[setter](unit === "ticks" ? String(Math.round(seconds * GCUT_TICKS)) : seconds, GCUT_ALL_MEDIA);
}

function gcutPointIs(pi, which, seconds, tolS) {
    return gcutNear((which === "in" ? pi.getInPoint() : pi.getOutPoint()).seconds, seconds, tolS);
}

/** Set one point, trying the remembered unit first, then the other. Returns true if it took. */
function gcutSetOne(pi, which, seconds, tolS) {
    var first = gcutState().gcutUnit || "seconds";
    var units = first === "seconds" ? ["seconds", "ticks"] : ["ticks", "seconds"];
    for (var u = 0; u < units.length; u++) {
        try { gcutTrySet(pi, which, seconds, units[u]); } catch (e) { continue; }
        if (gcutPointIs(pi, which, seconds, tolS)) { gcutState().gcutUnit = units[u]; return true; }
    }
    return false;
}

/**
 * Set both points. Order matters: Premiere may reject or clamp an in point past the current
 * out point, so when moving the range later, set out first. Then re-read BOTH.
 */
function gcutSetRange(pi, inS, outS, tolS) {
    var outFirst = inS >= pi.getOutPoint().seconds - tolS;
    var ok = outFirst
        ? gcutSetOne(pi, "out", outS, tolS) && gcutSetOne(pi, "in", inS, tolS)
        : gcutSetOne(pi, "in", inS, tolS) && gcutSetOne(pi, "out", outS, tolS);
    if (ok && gcutPointIs(pi, "in", inS, tolS) && gcutPointIs(pi, "out", outS, tolS)) return;
    // Say what Premiere actually holds: the only evidence we get from a real session.
    var got = "";
    try { got = " It holds " + pi.getInPoint().seconds.toFixed(3) + "-" + pi.getOutPoint().seconds.toFixed(3) + " s"; } catch (e) { got = ""; }
    throw new Error("Premiere didn't accept the source range " + inS.toFixed(3) + "-" + outS.toFixed(3) + " s on " +
        (pi.name || "a clip") + "." + got + (got ? " (tolerance " + tolS.toFixed(3) + " s)." : ""));
}

// ── multi-clip: the selected clips, cut at the same timeline moments ────────────────

function gcutKindTracks(seq, kind) { return kind === "audio" ? seq.audioTracks : seq.videoTracks; }
function gcutLabel(kind, index) { return (kind === "audio" ? "A" : "V") + (index + 1); }
function gcutSeqId(seq) { return String(seq.sequenceID || seq.name || ""); }

/** True if [s, e) overlaps [fromT, toT) by more than half a frame. */
function gcutOverlaps(s, e, fromT, toT, clock) { return e > fromT + clock.half && s < toT - clock.half; }

/**
 * Unrecorded audio under the selected video: an angle's linked audio may land on its track and
 * overwrite it (seen only afterwards), so it's refused, at Analyse and again at Apply.
 */
function gcutUnderMessage(label, name) {
    return label + " (" + name + ") sits under the selected video clips, and rebuilding them could overwrite it. " +
        "Select it too, or move it off the clips' time, then Analyse again.";
}

function gcutItemRecord(kind, trackIndex, it) {
    var fx = [];
    gcutEffects(it, kind === "audio" ? GCUT_AUDIO_INTRINSIC : GCUT_VIDEO_INTRINSIC, fx);
    return {
        kind: kind, trackIndex: trackIndex, label: gcutLabel(kind, trackIndex),
        startTicks: it.start.ticks, endTicks: it.end.ticks, name: it.name,
        mediaPath: it.projectItem.getMediaPath(), inS: it.inPoint.seconds, outS: it.outPoint.seconds,
        speed: gcutSpeed(it), effects: fx
    };
}

/**
 * name: "" = the selected clips. Records the selected video clips and the SELECTED audio, so
 * later edits never read the selection again. The clips may start and end at different places
 * (hand-synced angles): the returned start/end is the range R where the selected video span
 * (earliest start → latest end) and the selected audio span overlap. Only R gets transcribed.
 */
function gcutSnapshotSelection(nameJson) {
    try {
        var name = gcutParse(nameJson) || "";
        var seq = gcutSequence(), clock = gcutClock(seq);
        var video = [], t, i, it, named = null;
        for (t = 0; t < seq.videoTracks.numTracks; t++) {
            var items = gcutItems(seq.videoTracks[t]);
            for (i = 0; i < items.length; i++) {
                it = items[i];
                if (!it.projectItem) continue;
                var sel = typeof it.isSelected === "function" && it.isSelected();
                if (name === "") { if (sel) video.push({ item: it, track: t }); }
                else if (gcutNameMatches(it.name, name) && (named === null || (sel && !named.sel))) named = { item: it, track: t, sel: sel };
            }
        }
        if (named) video = [named];
        if (!video.length) {
            return gcutOk({ found: false,
                message: name === "" ? "No clip is selected in the timeline." : "No clip named " + name + " on the active sequence." });
        }
        var problems = [], out = { video: [], audio: [] }, vStart = null, vEnd = null;
        for (i = 0; i < video.length; i++) {
            var v = video[i].item, lbl = gcutLabel("video", video[i].track);
            if (vStart === null || gcutT(v.start) < vStart) vStart = gcutT(v.start);
            if (vEnd === null || gcutT(v.end) > vEnd) vEnd = gcutT(v.end);
            if (Math.abs(gcutSpeed(v) - 1) > 1e-6) problems.push(lbl + " isn't at 100% speed.");
            out.video.push(gcutItemRecord("video", video[i].track, v));
        }
        var aStart = null, aEnd = null;
        for (t = 0; t < seq.audioTracks.numTracks; t++) {
            var aItems = gcutItems(seq.audioTracks[t]);
            for (i = 0; i < aItems.length; i++) {
                it = aItems[i];
                if (!it.projectItem) continue;
                var s = gcutT(it.start), e = gcutT(it.end);
                if (typeof it.isSelected === "function" && it.isSelected()) {
                    if (aStart === null || s < aStart) aStart = s;
                    if (aEnd === null || e > aEnd) aEnd = e;
                    out.audio.push(gcutItemRecord("audio", t, it));
                    continue;
                }
                // An unselected item from a selected clip's own source, under it: the rebuild of
                // that clip would bring it along, so it has to be cut too, or unlinked.
                var linked = false;
                for (var k = 0; k < video.length; k++) {
                    var vi = video[k].item;
                    if (gcutNode(it) === gcutNode(vi) && e > gcutT(vi.start) + clock.half && s < gcutT(vi.end) - clock.half) {
                        problems.push(gcutLabel("audio", t) + " is linked to " + gcutLabel("video", video[k].track) +
                            " but isn't selected. Select it too, or unlink it.");
                        linked = true;
                        break;
                    }
                }
                // Any other unselected audio under the video: Apply refuses it (gcutAudioUnder), so say so now.
                if (!linked && gcutOverlaps(s, e, vStart, vEnd, clock)) problems.push(gcutUnderMessage(gcutLabel("audio", t), it.name));
            }
        }
        var startT = vStart, endT = vEnd; // R; falls back to the video span when there is none
        if (!out.audio.length) {
            problems.push("No audio clip is selected. Select the audio Genius Cut should transcribe along with the video clips.");
        } else if (Math.min(vEnd, aEnd) <= Math.max(vStart, aStart)) {
            problems.push("The selected audio doesn't overlap the selected video clips, so there's nothing to transcribe.");
        } else {
            startT = Math.max(vStart, aStart); endT = Math.min(vEnd, aEnd);
            // A selected item outside R would only slide at Apply, with nothing cut from it.
            for (i = 0; i < out.audio.length; i++) {
                it = out.audio[i];
                if (!gcutOverlaps(Number(it.startTicks), Number(it.endTicks), startT, endT, clock)) {
                    problems.push(it.label + " (" + it.name + ") is selected but lies outside the video clips' time. Deselect it, then Analyse again.");
                }
            }
            for (i = 0; i < out.video.length; i++) {
                it = out.video[i];
                if (!gcutOverlaps(Number(it.startTicks), Number(it.endTicks), startT, endT, clock)) {
                    problems.push(it.label + " (" + it.name + ") is selected but lies outside the selected audio's time. Deselect it, then Analyse again.");
                }
            }
        }
        return gcutOk({
            found: true, sequenceId: gcutSeqId(seq), startTicks: String(startT), endTicks: String(endT),
            startS: startT / GCUT_TICKS, durationS: (endT - startT) / GCUT_TICKS,
            fps: Math.round(clock.fps * 1000) / 1000, video: out.video, audio: out.audio, problems: problems
        });
    } catch (e) {
        return gcutFail(e);
    }
}

// ── gcutApplyCutsMulti: the same timeline moments cut from every recorded clip ──────

/**
 * Re-find each recorded item by kind, track and exact start; refuse if any moved or changed.
 * Each keeps its own start and end: the items needn't line up with each other or the range.
 */
function gcutRefind(seq, spec, clock) {
    var found = [], i, j, x, it, items;
    for (i = 0; i < spec.items.length; i++) {
        x = spec.items[i]; it = null;
        var tracks = gcutKindTracks(seq, x.kind), label = gcutLabel(x.kind, x.trackIndex);
        if (x.trackIndex < 0 || x.trackIndex >= tracks.numTracks) throw new Error(label + "'s clip changed since Analyse. Analyse again.");
        var track = tracks[x.trackIndex];
        items = gcutItems(track);
        for (j = 0; j < items.length; j++) if (items[j].start.ticks === String(x.startTicks)) it = items[j];
        if (!it || !it.projectItem || it.end.ticks !== String(x.endTicks)) {
            throw new Error(label + "'s clip changed since Analyse. Analyse again.");
        }
        if (typeof track.isLocked === "function" && track.isLocked()) throw new Error(label + " is locked. Unlock it to apply.");
        if (Math.abs(gcutSpeed(it) - 1) > 1e-6) throw new Error(label + " isn't at 100% speed. Nothing was changed.");
        // A source that fits the sequence's frame rate (gcutFits) snaps to its own frames. One that
        // doesn't (a variable-frame-rate phone, 24 in 25, a 29.995 screen recording in 30) is
        // "loose": cut on timeline time, with one of its own frames of slack wherever Premiere
        // floors a set point to them (gcutSlackS). Nothing is refused. Audio follows its project
        // item's frame rate (a camera's own audio floors to the camera's frames, measured); an
        // audio-only file (no rate, or a sample rate) has none, and snaps to the sequence's frames.
        // Audio WITH a frame rate comes from a video file (`av`): placing it drops its picture too.
        var srcFrameS = clock.frameS, loose = false, mediaFrameS = 0;
        var srcFps = x.kind === "audio" ? gcutMediaFps(it.projectItem) : gcutSourceFps(it.projectItem, clock);
        if (x.kind === "audio" && srcFps > GCUT_MAX_FRAME_RATE) srcFps = 0;
        if (srcFps > 0) {
            if (gcutFits(srcFps, clock)) srcFrameS = 1 / srcFps;
            else { loose = true; mediaFrameS = 1 / srcFps; }
        }
        var inS = loose ? gcutTrueInS(it.inPoint.seconds, mediaFrameS, clock.frameS) : it.inPoint.seconds;
        found.push({ kind: x.kind, trackIndex: x.trackIndex, label: label, item: it, pi: it.projectItem,
                     node: it.projectItem.nodeId, startT: gcutT(it.start), endT: gcutT(it.end),
                     inS: inS, outS: it.outPoint.seconds, srcFrameS: srcFrameS,
                     loose: loose, mediaFrameS: mediaFrameS, av: x.kind === "audio" && srcFps > 0 });
    }
    return found;
}

/**
 * Extra tolerance, in seconds, for a recorded item's source points: one of its own frames for a
 * loose item, video or audio (Premiere floors set points to them), none for any other. Lengths stay exact.
 */
function gcutSlackS(f) { return f.loose ? f.mediaFrameS : 0; }

/** The stretch {fromT, toT} the recorded items cover (only those of `kind`, if given), or null. */
function gcutSpan(found, kind) {
    var span = null;
    for (var i = 0; i < found.length; i++) {
        if (kind && found[i].kind !== kind) continue;
        if (!span) span = { fromT: found[i].startT, toT: found[i].endT };
        else { span.fromT = Math.min(span.fromT, found[i].startT); span.toT = Math.max(span.toT, found[i].endT); }
    }
    return span;
}

/** The recorded item of this kind on this track at exactly this start, or null. */
function gcutRecordedAt(found, kind, trackIndex, startT) {
    for (var f = 0; f < found.length; f++) {
        if (found[f].kind === kind && found[f].trackIndex === trackIndex && found[f].startT === startT) return found[f];
    }
    return null;
}

/** True if a recorded item of this kind sits on this track at exactly this start. */
function gcutRecorded(found, kind, trackIndex, startT) { return gcutRecordedAt(found, kind, trackIndex, startT) !== null; }

/**
 * Refuse if any audio under [startT, endT) (the video clips), on any audio track, wasn't recorded
 * at Analyse (see gcutUnderMessage). The snapshot keeps no unselected items, so whether it was
 * there at Analyse or added since can't be told: one message for both.
 */
function gcutAudioUnder(seq, spec, startT, endT, clock) {
    for (var t = 0; t < seq.audioTracks.numTracks; t++) {
        var items = gcutItems(seq.audioTracks[t]);
        for (var i = 0; i < items.length; i++) {
            var it = items[i], recorded = false;
            if (!gcutOverlaps(gcutT(it.start), gcutT(it.end), startT, endT, clock)) continue;
            for (var j = 0; j < spec.items.length; j++) {
                var x = spec.items[j];
                if (x.kind === "audio" && x.trackIndex === t && it.start.ticks === String(x.startTicks)) recorded = true;
            }
            if (!recorded) throw new Error(gcutUnderMessage(gcutLabel("audio", t), it.name));
        }
    }
}

/** The pieces each recorded item is cut into: plan[i] for items[i]. */
function gcutPlan(items, cutsT) {
    var plan = [];
    for (var i = 0; i < items.length; i++) plan.push(gcutItemPieces(items[i], cutsT, items[i].srcFrameS));
    return plan;
}

/** True if `it`, on this kind's track, is exactly one of the planned pieces of a recorded item there. */
function gcutAtPlanned(items, plan, kind, trackIndex, it, clock) {
    var s = gcutT(it.start), d = gcutT(it.end) - s, n = gcutNode(it);
    for (var k = 0; k < items.length; k++) {
        if (items[k].kind !== kind || items[k].trackIndex !== trackIndex || items[k].node !== n) continue;
        for (var p = 0; p < plan[k].length; p++) {
            if (gcutNear(s, plan[k][p].atT, clock.half) && gcutNear(d, plan[k][p].durT, clock.half)) return true;
        }
    }
    return false;
}

/**
 * Cut ranges (seconds relative to the range start) → sorted, merged [{startT, endT}] in sequence
 * ticks, each end snapped as a timeline time to whole sequence frames (the range start itself may
 * be off the grid, when an audio clip sets it). With `endT`, cuts are clipped to the whole frames
 * inside [startT, endT]: the range is all that was transcribed, and a cut reaching a frame past it
 * must not take the first frame of whatever follows. Empty ranges are dropped; refuses if none remain.
 */
function gcutCutTicks(cuts, startT, clock, endT) {
    if (!gcutIsArray(cuts)) throw new Error("There's nothing to cut, so nothing was changed.");
    var raw = [], i, tpf = clock.tpf;
    for (i = 0; i < cuts.length; i++) {
        var a = Math.round((startT + cuts[i].start * GCUT_TICKS) / tpf) * tpf;
        var b = Math.round((startT + cuts[i].end * GCUT_TICKS) / tpf) * tpf;
        if (endT !== undefined) { a = Math.max(a, Math.ceil(startT / tpf) * tpf); b = Math.min(b, Math.floor(endT / tpf) * tpf); }
        if (b > a) raw.push({ startT: a, endT: b });
    }
    raw.sort(function (x, y) { return x.startT - y.startT; });
    var out = [];
    for (i = 0; i < raw.length; i++) {
        if (out.length && raw[i].startT <= out[out.length - 1].endT) out[out.length - 1].endT = Math.max(out[out.length - 1].endT, raw[i].endT);
        else out.push(raw[i]);
    }
    if (!out.length) throw new Error("There's nothing to cut, so nothing was changed.");
    return out;
}

/** Ticks the cuts remove before timeline time `t` (part of a cut that contains `t`). */
function gcutRemovedBefore(cutsT, t) {
    var r = 0;
    for (var i = 0; i < cutsT.length; i++) {
        if (cutsT[i].endT <= t) r += cutsT[i].endT - cutsT[i].startT;
        else if (cutsT[i].startT < t) r += t - cutsT[i].startT;
    }
    return r;
}

/** Where an item's last kept frame ends once the cuts are taken out. */
function gcutNewEnd(f, cutsT) { return f.endT - gcutRemovedBefore(cutsT, f.endT); }

/**
 * An item {startT, endT, inS}'s kept stretches [{fromT, durT, atT, srcIn}]: each lands at
 * atT = fromT - removedBefore(fromT), the same mapping for every item, from source in point
 * inS + (fromT - startT) snapped to the grid srcFrameS: the source's frames (Premiere rounds set
 * points down to them), or the sequence's for audio. A loose item's (see gcutRefind) goes to the
 * NEAREST of its own frames (clean cuts, 2026-10-08): Premiere would floor it up to a whole own frame
 * early (58 ms for Camera B), which moved quiet cut edges onto speech; the nearest is at most half
 * a frame off. rawIn keeps the exact time: a piece running to the very end of its source can't
 * start later than that, and gcutLayItem falls back to the frame below it (gcutLayPiece).
 */
function gcutItemPieces(item, cutsT, srcFrameS) {
    var out = [], cursor = item.startT;
    function push(fromT, toT) {
        if (toT <= fromT) return;
        var rawIn = item.inS + (fromT - item.startT) / GCUT_TICKS;
        var srcIn = item.loose ? Math.round(rawIn / item.mediaFrameS) * item.mediaFrameS : Math.round(rawIn / srcFrameS) * srcFrameS;
        out.push({ fromT: fromT, durT: toT - fromT, atT: fromT - gcutRemovedBefore(cutsT, fromT), srcIn: srcIn, rawIn: item.loose ? rawIn : undefined });
    }
    for (var i = 0; i < cutsT.length; i++) {
        var c = cutsT[i];
        if (c.endT <= cursor || c.startT >= item.endT) continue;
        push(cursor, Math.min(c.startT, item.endT));
        cursor = Math.max(cursor, c.endT);
    }
    push(cursor, item.endT);
    return out;
}

/**
 * An item laid whole at its own original place, from its own in point (Restore and rollback). A
 * loose item's in point (its true one, gcutTrueInS) is used as it is: it isn't on the sequence
 * grid its pieces snap to, and snapping it would slip it a frame.
 */
function gcutWhole(f) {
    var srcIn = f.loose ? f.inS : Math.round(f.inS / f.srcFrameS) * f.srcFrameS;
    return [{ fromT: f.startT, durT: f.endT - f.startT, atT: f.startT, srcIn: srcIn }];
}

/**
 * Refuse if sliding an item left would lay it over a clip that wasn't recorded: on its own track,
 * the stretch it moves into, [its new start, its start), must hold only recorded items.
 */
function gcutCovers(seq, found, cutsT, clock) {
    for (var f = 0; f < found.length; f++) {
        var x = found[f], newStart = x.startT - gcutRemovedBefore(cutsT, x.startT);
        if (newStart >= x.startT) continue;
        var items = gcutItems(gcutKindTracks(seq, x.kind)[x.trackIndex]);
        for (var i = 0; i < items.length; i++) {
            var it = items[i], s = gcutT(it.start);
            if (gcutT(it.end) <= newStart + clock.half || s >= x.startT - clock.half || gcutRecorded(found, x.kind, x.trackIndex, s)) continue;
            throw new Error("Moving " + x.label + "'s clip left would cover " + it.name + " on " + x.label +
                ". Move that clip, or close the space first.");
        }
    }
}

/** How far `a`'s source runs ahead of `v`'s at the same timeline moment, in seconds (0 when in sync). */
function gcutSyncOffsetS(a, v) { return (a.inS - a.startT / GCUT_TICKS) - (v.inS - v.startT / GCUT_TICKS); }

/** True if `a` (audio from a video file) is in sync with video item `v`: the same source time at every moment. */
function gcutInSync(a, v, clock) { return Math.abs(gcutSyncOffsetS(a, v)) <= clock.frameS / 2 + gcutSlackS(a); }

/**
 * True if `a` (audio from a video file) is video item `v`'s own sound: the same file, starting with it, either
 * in sync or slipped against it by whole sequence frames. The editor syncs picture and sound by hand (Georg,
 * 2026-10-28: Restream's picture 3 frames after its own sound, unlinked); that offset is kept exactly
 * (gcutSlipTo puts each sound piece back on it after its video drops it in sync).
 */
function gcutOwnSound(a, v, clock) {
    if (a.node !== v.node || !gcutNear(a.startT, v.startT, clock.half)) return false;
    if (gcutInSync(a, v, clock)) return true;
    var off = gcutSyncOffsetS(a, v);
    return Math.abs(off - Math.round(off / clock.frameS) * clock.frameS) <= clock.frameS / 20 + gcutSlackS(a) + gcutSlackS(v);
}

/** Why same-file audio `a` isn't gcutOwnSound of video `v`, for a refusal. */
function gcutOffsetWhy(a, v, clock) {
    return gcutNear(a.startT, v.startT, clock.half) ? "is slipped against it by part of a frame" : "doesn't start with it";
}

/**
 * overwriteClip places a file's picture and sound together (measured, see the header): a video
 * clip's sound lands on A(same number), and audio from a video file (`av`) drops its picture on
 * V(same number). Refuse, before anything changes, what that would overwrite or can't rebuild:
 *   - a video clip's sound over audio that wasn't recorded (recorded audio there is laid after it,
 *     or is that very sound);
 *   - audio from a video file over anything on its video track but its own video (gcutOwnSound):
 *     a clip that wasn't recorded; a recorded one from a different file, whose own sound would land
 *     back on the audio; one from the same file not lined up with it, whose pieces wouldn't match.
 * Each item reaches over [its new start, its original end): Apply lays it inside, Restore and a
 * rollback at its original place.
 */
function gcutDropsCheck(seq, found, cutsT, clock) {
    for (var f = 0; f < found.length; f++) {
        var x = found[f], other = x.kind === "audio" ? "video" : "audio";
        if (x.kind === "audio" && !x.av) continue;
        var fromT = x.startT - gcutRemovedBefore(cutsT, x.startT), tracks = gcutKindTracks(seq, other), there = gcutLabel(other, x.trackIndex);
        if (x.trackIndex >= tracks.numTracks) {
            if (x.kind === "video") continue; // no audio track of that number: whatever lands anywhere is checked after
            throw new Error(x.label + "'s audio comes from a video file, and Premiere drops its picture onto " + there +
                " when it's placed, but this sequence has no " + there + ". Add a video track, then Apply again.");
        }
        var items = gcutItems(tracks[x.trackIndex]);
        for (var i = 0; i < items.length; i++) {
            var it = items[i], s = gcutT(it.start), rec = gcutRecordedAt(found, other, x.trackIndex, s);
            var reachT = rec ? rec.startT - gcutRemovedBefore(cutsT, rec.startT) : s;
            if (!gcutOverlaps(reachT, gcutT(it.end), fromT, x.endT, clock)) continue;
            if (x.kind === "video") {
                if (rec) continue;
                throw new Error("Placing " + x.label + " also drops its own sound onto " + there + ", which would cover " + it.name +
                    ". Move that clip off " + there + "'s time.");
            }
            if (!rec) {
                throw new Error(x.label + "'s audio comes from a video file, and Premiere drops its picture onto " + there + " when it's placed. " +
                    "Move that audio to a track whose video track has nothing else under it, or select that video too.");
            }
            if (rec.node !== x.node) {
                throw new Error(x.label + "'s audio and " + there + "'s video come from different files, so Genius Cut can't place both on these tracks. " +
                    "Put the audio on a track number with no selected video.");
            }
            if (!gcutOwnSound(x, rec, clock)) {
                throw new Error(x.label + "'s audio comes from the same file as " + there + "'s video but " + gcutOffsetWhy(x, rec, clock) +
                    ", so Genius Cut can't place both on these tracks without changing your sync. Put the audio on a track number with no selected video.");
            }
            if (!gcutInSync(x, rec, clock)) gcutQeTrack("audio", x.trackIndex); // slipping it back needs QE: refuse here, before anything changes
        }
    }
}

/**
 * Everything NOT recorded that overlaps [startT, endT), on every track. Recorded items are
 * matched by kind, track and start, not object identity: Premiere hands out a fresh wrapper
 * object every time a track's clips are read.
 */
function gcutOthers(seq, found, startT, endT) {
    var snap = [], tracks = gcutTracks(seq);
    for (var t = 0; t < tracks.length; t++) {
        var items = gcutItems(tracks[t].track);
        for (var i = 0; i < items.length; i++) {
            var it = items[i], ours = false, s = gcutT(it.start), e = gcutT(it.end);
            for (var f = 0; f < found.length; f++) {
                if ((found[f].kind === "audio") === tracks[t].audio && found[f].trackIndex === tracks[t].index && found[f].startT === s) ours = true;
            }
            if (!ours && e > startT && s < endT) {
                snap.push({ label: tracks[t].label, t: t, start: s, end: e, inS: it.inPoint.seconds, node: gcutNode(it) });
            }
        }
    }
    return snap;
}

/** Label of the first snapshot item that's no longer exactly where it was, or null. */
function gcutSnapshotIntact(seq, snap, clock) {
    var tracks = gcutTracks(seq);
    for (var k = 0; k < snap.length; k++) {
        var want = snap[k], items = gcutItems(tracks[want.t].track), found = false;
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (gcutNode(it) === want.node && gcutT(it.start) === want.start && gcutT(it.end) === want.end &&
                gcutNear(it.inPoint.seconds, want.inS, clock.frameS / 2)) { found = true; break; }
        }
        if (!found) return want.label;
    }
    return null;
}

/** True if `keep` (an others list) holds this item: same track, start and source. */
function gcutKept(keep, t, start, node) {
    for (var k = 0; k < keep.length; k++) if (keep[k].t === t && keep[k].start === start && keep[k].node === node) return true;
    return false;
}

function gcutHasNode(nodes, n) {
    for (var k = 0; k < nodes.length; k++) if (nodes[k] === n) return true;
    return false;
}

/** Remove items whose node is in `nodes` inside [fromT, toT] on every track, except `keep` (others). */
function gcutRemoveRange(seq, nodes, fromT, toT, clock, keep) {
    var tracks = gcutTracks(seq);
    for (var t = 0; t < tracks.length; t++) {
        var items = gcutItems(tracks[t].track);
        for (var i = items.length - 1; i >= 0; i--) {
            var it = items[i], n = gcutNode(it), s = gcutT(it.start), e = gcutT(it.end);
            if (!gcutHasNode(nodes, n) || s < fromT - clock.half || e > toT + clock.half) continue;
            if (!gcutKept(keep, t, s, n)) it.remove(false, false);
        }
    }
}

/**
 * Lay one recorded item's pieces ({durT, atT, srcIn}) on its own track, from its own source.
 * Pieces never reach outside the item's own [new start, original end], which the caller clears.
 *
 * A loose item's set points land up to one of its own frames early, so its pieces come out up to
 * a source frame long or short. Each is laid off-length on purpose, then its end is set to the
 * planned end (gcutTrimTo), so it ends up exact:
 *   - long (out + at least one source frame, in whole sequence frames) when what spills past the
 *     planned end stays before the item's LAST planned end, so the later pieces (and their linked
 *     audio, which a trim of the video leaves long) overwrite it; then trimmed back;
 *   - otherwise short (out set to the in point Premiere took + the length, which it floors), and
 *     extended: overwriting past the last planned end could take the head of the next clip, which
 *     no trim gives back. The last piece, and an item laid whole (Restore, rollback), always are.
 *
 * `sound` ({f, ends}, video only; see gcutSounds): the clip's own sound recorded under it. Each piece
 * drops its sound on that audio track (measured), which IS the audio piece starting there: its end
 * is set to ends[p] (setting the video's end leaves its sound as it was, measured).
 */
function gcutLayItem(seq, f, pieces, clock, sound) {
    var track = gcutKindTracks(seq, f.kind)[f.trackIndex], tolS = clock.frameS / 2 + gcutSlackS(f);
    var soundTrack = sound ? gcutKindTracks(seq, "audio")[sound.f.trackIndex] : null;
    var overT = f.loose ? Math.max(1, Math.ceil(f.mediaFrameS / clock.frameS - 1e-9)) * clock.tpf : 0;
    var lastEndT = pieces.length ? pieces[pieces.length - 1].atT + pieces[pieces.length - 1].durT : 0;
    for (var p = 0; p < pieces.length; p++) {
        var endT = pieces[p].atT + pieces[p].durT;
        var spill = f.loose && endT + overT + f.mediaFrameS * GCUT_TICKS <= lastEndT;
        try {
            gcutLayPiece(track, f, pieces[p], pieces[p].srcIn, spill ? overT : 0, tolS, clock);
        } catch (layErr) {
            // A piece set on the own frame after its exact time needs that much media past its
            // end: at the very end of the source there is none, and its end won't extend. Lay it
            // again from the frame below its exact time, where it always fits.
            var below = pieces[p].rawIn === undefined ? null : Math.floor(pieces[p].rawIn / f.mediaFrameS + 1e-6) * f.mediaFrameS;
            if (below === null || below >= pieces[p].srcIn - 1e-9) throw layErr;
            pieces[p].srcIn = below;
            gcutLayPiece(track, f, pieces[p], below, 0, tolS, clock);
        }
        if (sound && sound.ends[p] !== null) gcutTrimTo(soundTrack, sound.f, pieces[p].atT, sound.ends[p], clock);
        if (sound && sound.slip && sound.ins[p] !== null) gcutSlipTo(soundTrack, sound.f, pieces[p].atT, sound.ins[p], clock);
    }
}

/**
 * Put the sound piece just dropped at atT (in sync with its video) back on the editor's own sync: slip it, with
 * QE, by the whole sequence frames between its in point and inS. Measured 2026-10-28 (Premiere 26.5.2):
 * qeItem.slip("HH:MM:SS:FF", false) keeps the clip's place and length and moves its in point that much
 * EARLIER; "-HH:MM:SS:FF" moves it later. A piece that isn't there is left to gcutVerifyItems.
 */
function gcutSlipTo(track, f, atT, inS, clock) {
    var it = gcutLaidAt(track, f, atT, clock);
    if (!it) return;
    var frames = Math.round((it.inPoint.seconds - inS) / clock.frameS);
    if (!frames) return;
    var qi = gcutQeClipAt(gcutQeTrack(f.kind, f.trackIndex), atT, clock), done = false;
    try { done = !!qi && qi.slip((frames < 0 ? "-" : "") + gcutTimecode(Math.abs(frames) * clock.tpf, clock), false); } catch (e) { done = false; }
    if (!done) throw new Error("Premiere wouldn't slip " + f.label + "'s piece back onto your sync with " + gcutLabel("video", f.trackIndex) + ".");
}

/**
 * Lay one piece ({durT, atT}) from source time srcIn, overrunning by overT ticks (a loose piece
 * laid long, see gcutLayItem), and set a loose piece's end to its planned end. srcIn is on the
 * source frame grid (a fitting item's frames, a loose item's own: Premiere rounds set points down
 * to them). A loose piece's set point is aimed a quarter of an own frame after its frame, so the
 * floor lands on that frame whatever the float error (if Premiere holds the aim as it is, without
 * flooring, the frame itself is set instead); a fitting item falls back to a quarter frame later
 * only when float error rounds it a frame low.
 */
function gcutLayPiece(track, f, piece, srcIn, overT, tolS, clock) {
    var endT = piece.atT + piece.durT, nudge = f.srcFrameS / 4, lenS = (piece.durT + overT) / GCUT_TICKS;
    var frame = f.loose ? Math.floor(srcIn / f.mediaFrameS + 1e-6) * f.mediaFrameS : srcIn;
    var aim = f.loose ? frame + f.mediaFrameS / 4 : srcIn;
    try { gcutSetRange(f.pi, aim, aim + lenS, tolS); }
    catch (rangeErr) { gcutSetRange(f.pi, aim + nudge, aim + nudge + lenS, tolS); }
    if (f.loose && f.pi.getInPoint().seconds > frame + f.mediaFrameS / 8) gcutSetRange(f.pi, frame, frame + lenS, tolS);
    if (f.loose && !overT) {
        var shortOut = f.pi.getInPoint().seconds + piece.durT / GCUT_TICKS;
        if (f.pi.getOutPoint().seconds > shortOut && !gcutSetOne(f.pi, "out", shortOut, tolS)) {
            throw new Error("Premiere didn't accept the source out point " + shortOut.toFixed(3) + " s.");
        }
    }
    track.overwriteClip(f.pi, String(piece.atT));
    if (f.loose) gcutTrimTo(track, f, piece.atT, endT, clock);
}

/** The clip of `f`'s source starting at atT on this track, or null. */
function gcutLaidAt(track, f, atT, clock) {
    var items = gcutItems(track);
    for (var i = 0; i < items.length; i++) if (gcutNode(items[i]) === f.node && gcutNear(gcutT(items[i].start), atT, clock.half)) return items[i];
    return null;
}

/**
 * Set the end of the piece just laid at atT to endT (a loose item's trim or extension). A piece
 * that isn't there is left to gcutVerifyItems; one whose end won't take fails the edit.
 */
function gcutTrimTo(track, f, atT, endT, clock) {
    var it = gcutLaidAt(track, f, atT, clock);
    if (!it || gcutNear(gcutT(it.end), endT, clock.half)) return;
    try { it.end = gcutTimeFromTicks(endT); } catch (e) { it = null; }
    if (it) it = gcutLaidAt(track, f, atT, clock); // read back afresh
    if (!it || !gcutNear(gcutT(it.end), endT, clock.half)) throw new Error("Premiere wouldn't trim " + f.label + "'s piece to length.");
}

/**
 * True if a laid piece's in point, as Premiere reports it (gotS), fits the planned srcIn. A loose
 * piece's srcIn is already the own frame it is placed on: the nearest to its exact time, up to half
 * an own frame LATER than that (gcutItemPieces), so the bound below is against that frame. Premiere
 * floors the set point to the source's frames (up to gcutSlackS(f) early), and Premiere 26.5.2
 * (measured) reports a track item's in point floored again, to the SEQUENCE's frames. Both only
 * ever floor, so: never later than srcIn (to float error), and no earlier than the sequence frame
 * holding srcIn less the slack, less half a frame. Reported on the sequence's frames, a piece one
 * frame late reads past srcIn; reported as it is, an exact piece reads srcIn or a little earlier.
 */
function gcutInPointOk(gotS, srcIn, f, clock) {
    var low = Math.floor((srcIn - gcutSlackS(f)) / clock.frameS + 1e-6) * clock.frameS;
    return gotS <= srcIn + clock.frameS * 1e-6 && gotS >= low - clock.frameS / 2;
}

/**
 * null if every piece of `f` sits where planned; otherwise what's wrong. Start and length are
 * exact for every item (to half a sequence frame); the in point as gcutInPointOk allows.
 */
function gcutVerifyItems(seq, f, pieces, clock) {
    var items = gcutItems(gcutKindTracks(seq, f.kind)[f.trackIndex]);
    for (var p = 0; p < pieces.length; p++) {
        var ok = 0;
        for (var i = 0; i < items.length; i++) {
            var v = items[i];
            if (gcutNode(v) === f.node && gcutNear(gcutT(v.start), pieces[p].atT, clock.half) &&
                gcutNear(gcutT(v.end) - gcutT(v.start), pieces[p].durT, clock.half) &&
                gcutInPointOk(v.inPoint.seconds, pieces[p].srcIn, f, clock)) ok++;
        }
        if (ok !== 1) return "Kept span " + (p + 1) + " of " + pieces.length + " on " + f.label + " didn't land where or as expected.";
    }
    return null;
}

/**
 * True if `it`, on gcutTracks entry `track`, is a stray: a clip of a recorded source in [fromT, toT]
 * that is neither a planned piece of a recorded item on that track nor was there at Apply (others):
 * the sound a camera angle brought along, the picture audio from a video file brought along.
 */
function gcutStray(found, plan, nodes, track, it, fromT, toT, clock, others) {
    var n = gcutNode(it), s = gcutT(it.start);
    if (!gcutHasNode(nodes, n) || gcutKept(others, track.t, s, n)) return false;
    if (gcutT(it.end) <= fromT + clock.half || s >= toT - clock.half) return false;
    return !gcutAtPlanned(found, plan, track.audio ? "audio" : "video", track.index, it, clock);
}

function gcutNodes(found) {
    var nodes = [];
    for (var f = 0; f < found.length; f++) nodes.push(found[f].node);
    return nodes;
}

/** The first track still holding a stray (gcutStray), or null. */
function gcutStrayLeft(seq, found, plan, fromT, toT, clock, others) {
    var tracks = gcutTracks(seq), nodes = gcutNodes(found);
    for (var t = 0; t < tracks.length; t++) {
        var items = gcutItems(tracks[t].track);
        for (var i = 0; i < items.length; i++) if (gcutStray(found, plan, nodes, tracks[t], items[i], fromT, toT, clock, others)) return tracks[t];
    }
    return null;
}

/** What a stray left on `track` (from gcutStrayLeft) is, for the message. */
function gcutStrayMessage(track) {
    return track.audio ? "Audio a camera angle brought along couldn't be removed from " + track.label + "."
        : "The picture that audio from a video file brought along couldn't be removed from " + track.label + ".";
}

/** True if a recorded item of source `n` lives on this track (an entry of gcutTracks). */
function gcutHome(found, n, track) {
    for (var f = 0; f < found.length; f++) {
        if (found[f].node === n && (found[f].kind === "audio") === track.audio && found[f].trackIndex === track.index) return true;
    }
    return false;
}

/**
 * Pair each recorded video item with its own sound: the recorded audio from a video file on
 * A(same number) that gcutOwnSound accepts (gcutDropsCheck refuses any other audio from a video file
 * under it). A piece of that audio starting with a video piece is made by that piece's dropped sound;
 * the rest (past the video's end) are laid on their own. Returns, per item i:
 *   sound[i]: for a video item with its own sound recorded, { f: that audio item, ends: each video
 *             piece's sound end (the audio piece starting with it), or null where none does, ins: that audio
 *             piece's in point, slip: true when the sound is hand-slipped against the video (gcutSlipTo) }; else null;
 *   own[i]:   the pieces of found[i] to lay with overwriteClip (all of them, except for such audio).
 */
function gcutSounds(found, plan, clock) {
    var sound = [], own = [], i, j, p, q;
    for (i = 0; i < found.length; i++) { sound.push(null); own.push(plan[i]); }
    for (i = 0; i < found.length; i++) {
        if (found[i].kind !== "video") continue;
        for (j = 0; j < found.length; j++) {
            var a = found[j];
            if (a.kind !== "audio" || !a.av || a.trackIndex !== found[i].trackIndex || !gcutOwnSound(a, found[i], clock)) continue;
            var ends = [], ins = [], rest = [];
            for (q = 0; q < plan[i].length; q++) { ends.push(null); ins.push(null); }
            for (p = 0; p < plan[j].length; p++) {
                var made = false;
                for (q = 0; q < plan[i].length; q++) {
                    if (gcutNear(plan[i][q].atT, plan[j][p].atT, clock.half)) { ends[q] = plan[j][p].atT + plan[j][p].durT; ins[q] = plan[j][p].srcIn; made = true; }
                }
                if (!made) rest.push(plan[j][p]);
            }
            sound[i] = { f: a, ends: ends, ins: ins, slip: !gcutInSync(a, found[i], clock) };
            own[j] = rest;
            break;
        }
    }
    return { sound: sound, own: own };
}

/**
 * Lay every item (plan[i] = found[i]'s pieces) in the order overwriteClip's drops need (measured: a
 * file's picture and sound land together, on the same track number; gcutDropsCheck refused the rest):
 *   1. audio from a video file, the pieces its own video's sound doesn't make: the pictures they
 *      drop land where no other clip is, and come off in step 3;
 *   2. video, each piece's sound landing on A(same number): the audio piece itself where its own
 *      sound is recorded there (its end set to the audio piece's), a stray anywhere else;
 *   3. remove every stray in [fromT, toT] (gcutStray), sound and pictures alike;
 *   4. audio-only files, last: they drop nothing.
 */
function gcutLayAll(seq, found, plan, fromT, toT, clock, others) {
    var i, drops = gcutSounds(found, plan, clock);
    for (i = 0; i < found.length; i++) if (found[i].av) gcutLayItem(seq, found[i], drops.own[i], clock, null);
    for (i = 0; i < found.length; i++) if (found[i].kind === "video") gcutLayItem(seq, found[i], plan[i], clock, drops.sound[i]);
    gcutRemoveStrays(seq, found, plan, fromT, toT, clock, others);
    for (i = 0; i < found.length; i++) if (found[i].kind === "audio" && !found[i].av) gcutLayItem(seq, found[i], plan[i], clock, null);
}

/**
 * True if `f`'s source still sits on its own track inside [fromT, toT), the stretch it vacated
 * at its end: an original whose remove() silently did nothing leaves its tail there. A planned
 * piece of another recorded item of the same source on that track may rightly sit there.
 */
function gcutTailLeft(seq, f, fromT, toT, clock, found, plan) {
    var items = gcutItems(gcutKindTracks(seq, f.kind)[f.trackIndex]);
    for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (gcutNode(it) === f.node && gcutOverlaps(gcutT(it.start), gcutT(it.end), fromT, toT, clock) &&
            !gcutAtPlanned(found, plan, f.kind, f.trackIndex, it, clock)) return true;
    }
    return false;
}

/**
 * Remove every stray (gcutStray) in [fromT, toT], on every track. remove() leaves the linked
 * partner (measured), so a planned piece keeps its own. One that doesn't come off is reported by
 * gcutStrayLeft.
 */
function gcutRemoveStrays(seq, found, plan, fromT, toT, clock, others) {
    var tracks = gcutTracks(seq), nodes = gcutNodes(found);
    for (var t = 0; t < tracks.length; t++) {
        var items = gcutItems(tracks[t].track);
        for (var i = items.length - 1; i >= 0; i--) {
            if (gcutStray(found, plan, nodes, tracks[t], items[i], fromT, toT, clock, others)) items[i].remove(false, false);
        }
    }
}

/**
 * Put every recorded item back at its own original place, from its own in point (Restore and
 * rollback). Everything of ours inside the items' span goes first. True if verifiably back.
 */
function gcutRelayAll(seq, rec, clock, others) {
    var whole = [];
    for (var i = 0; i < rec.items.length; i++) whole.push(gcutWhole(rec.items[i]));
    return gcutRelay(seq, rec.items, whole, clock, others);
}

/**
 * Clear everything of ours inside the items' span (keeping `others`), lay plan[i] for items[i], and
 * check. True if every piece verifiably landed and nothing stray is left; false (never throws) if not.
 */
function gcutRelay(seq, items, plan, clock, others) { return gcutRelaySpan(seq, items, plan, gcutSpan(items), clock, others); }

/** gcutRelay over an explicit span {fromT, toT} holding every piece of ours and every planned place (a move reaches past the items' own span). */
function gcutRelaySpan(seq, items, plan, span, clock, others) {
    try {
        var i;
        gcutRemoveRange(seq, gcutNodes(items), span.fromT, span.toT, clock, others);
        gcutLayAll(seq, items, plan, span.fromT, span.toT, clock, others);
        for (i = 0; i < items.length; i++) if (gcutVerifyItems(seq, items[i], plan[i], clock)) return false;
        return !gcutStrayLeft(seq, items, plan, span.fromT, span.toT, clock, others);
    } catch (e) {
        return false;
    }
}

// ── clean cuts: a short crossfade at every cut in the recorded audio ───────────────

var GCUT_CROSSFADE = "Constant Power";
var GCUT_CROSSFADE_FRAMES = "00:00:00:02"; // 2 frames, centred on the cut

/**
 * Add a 2-frame Constant Power crossfade, centred, at every internal cut of every recorded audio
 * item (each piece's start but the item's first), through QE as measured in Premiere 26.5.2: the
 * transition goes on the clip AFTER the cut (applyToStart), and removing the clip removes it, so
 * Restore and a rollback need nothing. Runs only after Apply verified; it never throws and never
 * changes a clip: anything unavailable is skipped. A crossfade counts as added only if the track's
 * transition count went up. Returns { added, wanted }.
 */
function gcutCrossfades(seq, found, plan, clock) {
    var wanted = 0, added = 0, i, p;
    for (i = 0; i < found.length; i++) if (found[i].kind === "audio" && plan[i].length > 1) wanted += plan[i].length - 1;
    if (!wanted) return { added: 0, wanted: 0 };
    var qseq = null, fade = null;
    try {
        app.enableQE();
        qseq = qe.project.getActiveSequence();
        fade = qe.project.getAudioTransitionByName(GCUT_CROSSFADE);
    } catch (e) { return { added: 0, wanted: wanted }; }
    if (!qseq || !fade) return { added: 0, wanted: wanted };
    for (i = 0; i < found.length; i++) {
        if (found[i].kind !== "audio") continue;
        var qt = null;
        try { qt = qseq.getAudioTrackAt(found[i].trackIndex); } catch (e2) { qt = null; }
        if (!qt) continue;
        for (p = 1; p < plan[i].length; p++) {
            try {
                var at = gcutQeClipAt(qt, plan[i][p].atT, clock);
                if (!at) continue;
                var before = Number(qt.numTransitions);
                at.addTransition(fade, true, GCUT_CROSSFADE_FRAMES, "00:00:00:00", 0.5, false, true);
                var after = Number(qt.numTransitions);
                if (isFinite(before) && isFinite(after) ? after > before : true) added++;
            } catch (e3) { /* skipped: reported in the count */ }
        }
    }
    return { added: added, wanted: wanted };
}

/** The QE clip on this QE track starting at atT (to half a frame), or null. */
function gcutQeClipAt(qt, atT, clock) {
    for (var k = 0; k < qt.numItems; k++) {
        var it = qt.getItemAt(k);
        if (it && it.type === "Clip" && gcutNear(Number(it.start.secs) * GCUT_TICKS, atT, clock.half)) return it;
    }
    return null;
}

/**
 * spec: { sequenceId, startTicks, endTicks, items: [{kind, trackIndex, startTicks, endTicks}],
 *         cuts: [{start, end}] } — the gcutSnapshotSelection record (startTicks/endTicks are the
 * range R); cuts are removed ranges in seconds relative to startTicks. Stash: "m@" + startTicks,
 * { startT, endT, cutsT, rebuiltEndT, gapClosed, sequenceId, others, items } with each item's own
 * original startT/endT/inS, whether it is loose (mediaFrameS: its own frame length), so
 * Restore and Close gap use the same tolerances, and whether it is audio from a video file (av),
 * so Restore lays in the same order (gcutLayAll).
 */
function gcutApplyCutsMulti(specJson) {
    try {
        var spec = gcutParse(specJson), k;
        var seq = gcutSequence(), clock = gcutClock(seq);
        if (spec.sequenceId && gcutSeqId(seq) !== String(spec.sequenceId)) {
            throw new Error("A different sequence is open than the one you analysed. Open that sequence, or Analyse this one.");
        }
        if (!gcutIsArray(spec.items) || !spec.items.length) throw new Error("No clips were recorded at Analyse. Analyse again.");
        var startT = Number(spec.startTicks), endT = Number(spec.endTicks);
        var found = gcutRefind(seq, spec, clock);
        var vSpan = gcutSpan(found, "video");
        // R lies inside the video clips (the snapshot made it so); a range outside them would lay
        // pieces before the stretch that the checks and the rollback look at.
        if (!vSpan || !(vSpan.fromT <= startT && startT < endT && endT <= vSpan.toT)) {
            throw new Error("The selected clips changed since Analyse. Analyse again.");
        }
        var cutsT = gcutCutTicks(spec.cuts, startT, clock, endT);
        gcutDropsCheck(seq, found, cutsT, clock); // before gcutAudioUnder: it names what lands where
        gcutAudioUnder(seq, spec, vSpan.fromT, vSpan.toT, clock);
        gcutCovers(seq, found, cutsT, clock);
        // Every piece lands inside span: an item only ever slides left, and never past the first cut.
        var span = gcutSpan(found), rebuiltEndT = span.fromT;
        for (k = 0; k < found.length; k++) rebuiltEndT = Math.max(rebuiltEndT, gcutNewEnd(found[k], cutsT));
        var others = gcutOthers(seq, found, span.fromT, span.toT);
        var key = "m@" + spec.startTicks;
        var rec = { sequenceId: gcutSeqId(seq), startT: startT, endT: endT, cutsT: cutsT, rebuiltEndT: rebuiltEndT,
                    gapClosed: false, items: found, others: others };
        // A new Apply at the same start replaces the earlier record (that Restore is meaningless once
        // the timeline changed again); if this one rolls back cleanly, the earlier record comes back.
        var stash = gcutState().gcutStash, hadPrev = stash.hasOwnProperty(key), prev = stash[key];
        stash[key] = rec; // written before anything changes, so it can always be rolled back
        var r;
        try {
            r = gcutCutCore(seq, clock, found, cutsT, rec);
        } catch (early) { // it throws only before changing anything
            if (hadPrev) stash[key] = prev; else delete stash[key];
            throw early;
        }
        if (r.ok) return gcutOk(r);
        if (r.rolledBack) { if (hadPrev) stash[key] = prev; else delete stash[key]; }
        return gcutOk(gcutCutFailed(seq, clock, r, others));
    } catch (e) {
        return gcutFail(e);
    }
}

/**
 * The cut itself, shared by Apply and the assistant's cut tool: take the recorded items `found` off,
 * lay their pieces for cutsT, verify every piece, then crossfade the recorded audio. All or nothing:
 * any failure lays every item back at its own original place (gcutRelayAll over rec, keeping
 * rec.others). The bin items' own in/out marks are always left as they were. It throws only before
 * changing anything; otherwise it returns Apply's reply { ok: true, appliedCount, clipCount,
 * expectedDuration, actualDuration, trailingGapS, crossfades, warning? }, or { ok: false, rolledBack,
 * message } with a neutral message (what went wrong, no advice): see gcutCutFailed.
 * rec: { startT, endT, items: found, others, ... } as Apply records it.
 */
function gcutCutCore(seq, clock, found, cutsT, rec) {
    var marks = [], k;
    try {
        for (k = 0; k < found.length; k++) {
            var seen = false;
            for (var m = 0; m < marks.length; m++) if (marks[m].node === found[k].node) seen = true;
            if (!seen) marks.push({ pi: found[k].pi, node: found[k].node, inS: found[k].pi.getInPoint().seconds, outS: found[k].pi.getOutPoint().seconds });
        }
        var span = gcutSpan(found), plan = gcutPlan(found, cutsT), removedT = gcutRemovedBefore(cutsT, rec.endT), others = rec.others;
        try {
            for (k = 0; k < found.length; k++) found[k].item.remove(false, false);
            var nodes = [];
            for (k = 0; k < found.length; k++) nodes.push(found[k].node);
            gcutRemoveRange(seq, nodes, span.fromT, span.toT, clock, others); // linked partners some builds leave behind
            gcutLayAll(seq, found, plan, span.fromT, span.toT, clock, others);
            for (k = 0; k < found.length; k++) {
                var bad = gcutVerifyItems(seq, found[k], plan[k], clock);
                if (bad) throw new Error(bad);
                if (gcutTailLeft(seq, found[k], gcutNewEnd(found[k], cutsT), found[k].endT, clock, found, plan)) {
                    throw new Error("The original clip on " + found[k].label + " didn't come off the timeline: part of it is still in the gap.");
                }
            }
            var stray = gcutStrayLeft(seq, found, plan, span.fromT, span.toT, clock, others);
            if (stray) throw new Error(gcutStrayMessage(stray));
            var hit = gcutSnapshotIntact(seq, others, clock);
            if (hit) throw new Error("The rebuild overwrote something on " + hit + ".");
            var keptS = (rec.endT - rec.startT - removedT) / GCUT_TICKS; // the range, once the cuts are out
            // Verified: the edit stands whatever happens next. Crossfades are a finish on top.
            var fades = { added: 0, wanted: 0 };
            try { fades = gcutCrossfades(seq, found, plan, clock); } catch (fadeErr) { fades = { added: 0, wanted: 0 }; }
            var missed = fades.wanted - fades.added;
            return { ok: true, appliedCount: cutsT.length, clipCount: found.length,
                expectedDuration: keptS, actualDuration: keptS, trailingGapS: removedT / GCUT_TICKS, crossfades: fades.added,
                warning: missed > 0 ? "Couldn't add " + missed + " crossfade" + (missed === 1 ? "" : "s") + "; the cuts are in place." : undefined };
        } catch (inner) {
            var back = false;
            try { back = gcutRelayAll(seq, rec, clock, others); } catch (ignored) { back = false; }
            return { ok: false, rolledBack: back, message: inner.message };
        }
    } finally {
        // Always leave the bin items' own in/out marks as they were.
        for (k = 0; k < marks.length; k++) {
            try { gcutSetRange(marks[k].pi, marks[k].inS, marks[k].outS, clock.frameS / 2); } catch (ignored2) { /* best effort */ }
        }
    }
}

/** The reply for a gcutCutCore that failed (r): whether every clip went back, and anything else that changed. */
function gcutCutFailed(seq, clock, r, others) {
    var damage = gcutSnapshotIntact(seq, others, clock);
    return { ok: false, rolledBack: r.rolledBack, appliedCount: 0, clipCount: 0, expectedDuration: 0,
        actualDuration: 0, trailingGapS: 0,
        message: r.message + (r.rolledBack ? " Every clip was put back." : " They couldn't be put back automatically: use Premiere's Undo.") +
            (damage ? " Something on " + damage + " was changed too: use Undo to recover it." : "") };
}

// ── gcutRestoreMulti: every recorded clip back as it was ────────────────────────────

/** The Apply record for this start on the open sequence; refuses with `missing` if there is none. */
function gcutRecord(seq, spec, missing) {
    var rec = gcutState().gcutStash["m@" + spec.startTicks];
    if (!rec) throw new Error(missing);
    if (rec.sequenceId !== gcutSeqId(seq)) {
        throw new Error("A different sequence is open than the one Genius Cut edited. Open that sequence first.");
    }
    return rec;
}

/**
 * Our rebuilt pieces on the timeline now: only clips sitting exactly where Apply planned a piece
 * of a recorded item, on its own track, and never one that was there at Apply (rec.others). Any
 * other clip of a recorded source (a razored head, a second copy) is someone else's: it ends up
 * among the others, so Restore keeps it, or refuses rather than overwrite it.
 */
function gcutOursNow(seq, rec, clock) {
    var ours = [], plan = gcutPlan(rec.items, rec.cutsT), nV = seq.videoTracks.numTracks;
    for (var i = 0; i < rec.items.length; i++) {
        var f = rec.items[i], tracks = gcutKindTracks(seq, f.kind), t = (f.kind === "audio" ? nV : 0) + f.trackIndex;
        if (f.trackIndex >= tracks.numTracks) throw new Error(f.label + " no longer exists. Use Premiere's Undo instead.");
        var items = gcutItems(tracks[f.trackIndex]);
        for (var j = 0; j < items.length; j++) {
            var it = items[j], s = gcutT(it.start);
            if (gcutNode(it) !== f.node || gcutKept(rec.others, t, s, f.node)) continue;
            if (gcutAtPlanned([f], [plan[i]], f.kind, f.trackIndex, it, clock)) ours.push({ kind: f.kind, trackIndex: f.trackIndex, startT: s });
        }
    }
    return ours;
}

/**
 * Restore re-lays every recorded clip at its own original place on its own track (and the camera
 * angles bring their sound along, onto an audio track under them; audio from a video file drops its
 * picture on the video track of its number). Refuse if anything that wasn't there at Apply now sits
 * where that would overwrite it. Returns the refusal, or null.
 */
function gcutInTheWay(seq, rec, others, clock) {
    var tracks = gcutTracks(seq);
    for (var i = 0; i < others.length; i++) {
        var o = others[i], tr = tracks[o.t];
        if (gcutKept(rec.others, o.t, o.start, o.node)) continue;
        for (var j = 0; j < rec.items.length; j++) {
            var f = rec.items[j], own = (f.kind === "audio") === tr.audio && f.trackIndex === tr.index;
            var picture = !tr.audio && f.av && f.trackIndex === tr.index;
            if (!own && !picture && !(tr.audio && f.kind === "video")) continue;
            if (o.end <= f.startT + clock.half || o.start >= f.endT - clock.half) continue;
            if (o.end > gcutNewEnd(f, rec.cutsT) + clock.half) {
                return "Something was placed in the gap on " + o.label + " since, and restoring would overwrite it. Use Premiere's Undo instead.";
            }
            return "Something was placed on " + o.label + " over the cut clips since, and restoring would overwrite it. Use Premiere's Undo instead.";
        }
    }
    return null;
}

/** spec: { startTicks } — the range start recorded at Analyse. */
function gcutRestoreMulti(specJson) {
    var seq, clock, rec, marks = [], k;
    try {
        var spec = gcutParse(specJson);
        seq = gcutSequence(); clock = gcutClock(seq);
        rec = gcutRecord(seq, spec, "There's no Genius Cut edit to restore on these clips in this session. Use Premiere's Undo instead.");
        if (rec.gapClosed) throw new Error("The gap was already closed, so restoring would overlap what moved. Use Premiere's Undo instead.");
        var span = gcutSpan(rec.items); // every piece of ours and every original place lies inside it
        var ours = gcutOursNow(seq, rec, clock);
        var others = gcutOthers(seq, ours, span.fromT, span.toT);
        var blocked = gcutInTheWay(seq, rec, others, clock);
        if (blocked) throw new Error(blocked);
        for (k = 0; k < rec.items.length; k++) {
            var seen = false;
            for (var m = 0; m < marks.length; m++) if (marks[m].node === rec.items[k].node) seen = true;
            if (!seen) marks.push({ pi: rec.items[k].pi, node: rec.items[k].node, inS: rec.items[k].pi.getInPoint().seconds, outS: rec.items[k].pi.getOutPoint().seconds });
        }
        // If Restore fails part-way the timeline would hold a mix of whole clips and pieces: lay the
        // cut version back from the record, so it is exactly as Apply left it (and the record, kept
        // as it was, still matches it for another Restore or Close gap). Only if that fails too, Undo.
        if (!gcutRelayAll(seq, rec, clock, others)) {
            var cutBack = gcutRelay(seq, rec.items, gcutPlan(rec.items, rec.cutsT), clock, others);
            throw new Error(cutBack ? "The original clips didn't go back as expected, so the cut version was put back as it was. Try Restore again, or use Premiere's Undo."
                : "The original clips didn't go back as expected, and the cut version couldn't be put back either. Use Premiere's Undo.");
        }
        var hit = gcutSnapshotIntact(seq, others, clock);
        if (hit) throw new Error("Restoring changed something on " + hit + ". Use Premiere's Undo.");
        delete gcutState().gcutStash["m@" + spec.startTicks];
        return gcutOk({ ok: true });
    } catch (e) {
        return gcutFail(e);
    } finally {
        // Always leave the bin items' own in/out marks as they were.
        for (k = 0; k < marks.length; k++) {
            try { gcutSetRange(marks[k].pi, marks[k].inS, marks[k].outS, clock.frameS / 2); } catch (ignored) { /* best effort */ }
        }
    }
}

// ── gcutCloseGapMulti ───────────────────────────────────────────────────────────────

/** Sequence time as m:ss.s, for messages. */
function gcutClockText(ticks) {
    var tenths = Math.round(ticks / GCUT_TICKS * 10), m = Math.floor(tenths / 600), s = (tenths - m * 600) / 10;
    return m + ":" + (s < 10 ? "0" : "") + s.toFixed(1);
}

/** True if a rebuilt piece (from gcutOursNow) sits on this track at exactly this start. */
function gcutOurs(ours, track, startT) {
    for (var k = 0; k < ours.length; k++) {
        if ((ours[k].kind === "audio") === track.audio && ours[k].trackIndex === track.index && ours[k].startT === startT) return true;
    }
    return false;
}

/**
 * Slide every clip Apply didn't rebuild that starts at or after the range start left by what the
 * cuts removed before it (t -> t - removedBefore(t)), on every track: the mapping the recorded
 * clips already got, so titles, B-roll and music stay in step with the speech. The rebuilt pieces
 * are already in place and never move; clips starting before the range never move. Refuses,
 * before moving anything, a rebuilt piece edited since Apply (it would slide a second time), a
 * clip that crosses a cut (it would need cutting itself), a locked track with a clip to move, and
 * a slide that would land on a clip. Items already moved as a linked partner are not moved twice.
 * spec: { startTicks } — the range start recorded at Analyse.
 */
function gcutCloseGapMulti(specJson) {
    try {
        var spec = gcutParse(specJson);
        var seq = gcutSequence(), clock = gcutClock(seq);
        var rec = gcutRecord(seq, spec, "There's no Genius Cut edit on these clips in this session.");
        if (rec.gapClosed) return gcutOk({ ok: true, movedCount: 0 });

        var ours = gcutOursNow(seq, rec, clock), movers = [], finals = [], tracks = gcutTracks(seq), t, i, j, c, it;
        var span = gcutSpan(rec.items);
        for (t = 0; t < tracks.length; t++) {
            var items = gcutItems(tracks[t].track), later = false;
            finals.push([]); // where each clip on this track ends up
            for (i = 0; i < items.length; i++) {
                it = items[i];
                var s = gcutT(it.start), e = gcutT(it.end), shift = 0, n = gcutNode(it);
                // A clip of a recorded source on its own track, among the rebuilt pieces, that is neither
                // a planned piece nor was there at Apply is a piece edited since: it already slid once.
                if (gcutHome(rec.items, n, tracks[t]) && gcutOverlaps(s, e, span.fromT, span.toT, clock) &&
                    !gcutOurs(ours, tracks[t], s) && !gcutKept(rec.others, t, s, n)) {
                    throw new Error("A rebuilt clip on " + tracks[t].label + " changed since Apply. Close the gap by hand.");
                }
                if (s >= rec.startT - clock.half && !gcutOurs(ours, tracks[t], s)) {
                    for (c = 0; c < rec.cutsT.length; c++) {
                        if (gcutOverlaps(s, e, rec.cutsT[c].startT, rec.cutsT[c].endT, clock)) {
                            throw new Error(it.name + " on " + tracks[t].label + " crosses a cut at " + gcutClockText(rec.cutsT[c].startT) +
                                ". Move it, or close the gap by hand.");
                        }
                    }
                    shift = gcutRemovedBefore(rec.cutsT, s);
                }
                if (shift > clock.half) {
                    movers.push({ item: it, startT: s, target: s - shift, label: tracks[t].label });
                    later = true;
                } else shift = 0;
                finals[t].push({ startT: s - shift, endT: e - shift, moves: shift > 0 });
            }
            if (later && typeof tracks[t].track.isLocked === "function" && tracks[t].track.isLocked()) {
                throw new Error(tracks[t].label + " is locked. Unlock it or close the gap by hand.");
            }
        }
        // The layout each track would end up with: a clip that moves may not overlap any other.
        for (t = 0; t < tracks.length; t++) {
            var fin = finals[t];
            for (i = 0; i < fin.length; i++) {
                for (j = i + 1; j < fin.length; j++) {
                    if ((fin[i].moves || fin[j].moves) && gcutOverlaps(fin[i].startT, fin[i].endT, fin[j].startT, fin[j].endT, clock)) {
                        throw new Error("Closing the gap would overlap a clip on " + tracks[t].label + ", so nothing was moved.");
                    }
                }
            }
        }
        movers.sort(function (a, b) { return a.startT - b.startT; });
        rec.gapClosed = true; // from here on Restore must not run: later clips may have moved
        for (i = 0; i < movers.length; i++) {
            var now = gcutT(movers[i].item.start);
            if (!gcutNear(now, movers[i].target, clock.half)) movers[i].item.move(gcutTimeFromTicks(movers[i].target - now));
        }
        for (i = 0; i < movers.length; i++) {
            if (!gcutNear(gcutT(movers[i].item.start), movers[i].target, clock.half)) {
                return gcutOk({ ok: false, movedCount: i,
                    message: "A clip on " + movers[i].label + " didn't move as expected. Use Premiere's Undo." });
            }
        }
        return gcutOk({ ok: true, movedCount: movers.length });
    } catch (e) {
        return gcutFail(e);
    }
}

// ── the assistant's toolbox: the tools Claude calls ───────────────────────────────────

/*
 * Same contract as the rest of this file: each gcutTool* takes one JSON-encoded string and returns
 * a JSON string; failures return "Error: <message>" and never throw.
 *
 * Clip ids are <V|A><track>@<startTicks>#<nodeId>: the track, the timeline start and the source
 * project item. A TrackItem's own nodeId changes whenever it is laid again (measured 2026-10-14),
 * so it can't name a clip.
 */

var GCUT_STALE = "The timeline changed since you read it; call get_sequence again.";

/** A clip's id (see this section's header). */
function gcutClipId(kind, trackIndex, it) {
    return gcutLabel(kind, trackIndex) + "@" + it.start.ticks + "#" + (gcutNode(it) || "");
}

/** The ids' clips, as [{kind, trackIndex, item}]; an id named twice counts once. Refuses any id that matches nothing. */
function gcutResolveIds(seq, ids) {
    if (!gcutIsArray(ids) || !ids.length) throw new Error("Choose at least one clip (its id from get_sequence).");
    var out = [], i, j, k;
    for (i = 0; i < ids.length; i++) {
        var m = /^([VA])(\d+)@(\d+)#(.*)$/.exec(String(ids[i])), hit = null;
        if (m) {
            var kind = m[1] === "A" ? "audio" : "video", t = Number(m[2]) - 1, tracks = gcutKindTracks(seq, kind);
            if (t >= 0 && t < tracks.numTracks) {
                var items = gcutItems(tracks[t]);
                for (j = 0; j < items.length; j++) {
                    if (items[j].start.ticks === m[3] && String(gcutNode(items[j]) || "") === m[4]) hit = { kind: kind, trackIndex: t, item: items[j] };
                }
            }
        }
        if (!hit) throw new Error(GCUT_STALE);
        var dup = false;
        for (k = 0; k < out.length; k++) if (out[k].kind === hit.kind && out[k].trackIndex === hit.trackIndex && out[k].item.start.ticks === hit.item.start.ticks) dup = true;
        if (!dup) out.push(hit);
    }
    return out;
}

/** Where the sequence's last clip ends, in ticks (0 when it is empty). */
function gcutSeqEndT(seq) {
    var end = 0, tracks = gcutTracks(seq);
    for (var t = 0; t < tracks.length; t++) {
        var items = gcutItems(tracks[t].track);
        for (var i = 0; i < items.length; i++) end = Math.max(end, gcutT(items[i].end));
    }
    return end;
}

/** The clip's source file, or its project item's name when it has none (a graphic). */
function gcutSource(it) {
    if (!it.projectItem) return "";
    try { return String(it.projectItem.getMediaPath()); } catch (e) { return String(it.projectItem.name); }
}

/**
 * The clip's true source in point: a loose clip's (see gcutRefind: its own frame rate doesn't fit the
 * sequence's) is reported floored to the sequence's frames, so it is corrected with gcutTrueInS, the
 * way gcutRefind records it. Any other clip's is as reported.
 */
function gcutClipInS(kind, it, clock) {
    var reported = it.inPoint.seconds;
    if (!it.projectItem) return reported;
    var srcFps = kind === "audio" ? gcutMediaFps(it.projectItem) : gcutSourceFps(it.projectItem, clock);
    if (kind === "audio" && srcFps > GCUT_MAX_FRAME_RATE) srcFps = 0;
    if (srcFps > 0 && !gcutFits(srcFps, clock)) return gcutTrueInS(reported, 1 / srcFps, clock.frameS);
    return reported;
}

/** The clip's effects, by name, without the intrinsic ones (Motion, Opacity, Volume...): what a cut's rebuild drops. */
function gcutClipEffects(kind, it) {
    var fx = [];
    gcutEffects(it, kind === "audio" ? GCUT_AUDIO_INTRINSIC : GCUT_VIDEO_INTRINSIC, fx);
    return fx;
}

/** The sequence's markers, in timeline order. */
function gcutMarkerList(seq) {
    var out = [], m = seq.markers.getFirstMarker();
    while (m) { out.push(m); m = seq.markers.getNextMarker(m); }
    return out;
}

/** A marker as the tools report and record it. */
function gcutMarkerRecord(m) {
    var colour = 0;
    try { colour = Number(m.getColorByIndex()); } catch (e) { colour = 0; }
    return { id: String(m.guid), startS: m.start.seconds, endS: m.end.seconds, name: String(m.name || ""),
             comments: String(m.comments || ""), colour: colour };
}

/**
 * args: { fromS?, toS? } — limits the clips and markers to those overlapping that stretch.
 * Returns { sequenceId, name, fps, durationS, tracks: [{kind, index, name, muted}], clips: [{id, track,
 * name, startS, endS, inS (a loose clip's true one, gcutClipInS), source, selected, enabled, effects (gcutClipEffects),
 * speed (gcutSpeed: 1 = 100%, negative = reversed)}], markers: [{id, startS, endS, name, comments,
 * colour}], selection: [clip ids] }. Track index and clip track are 1-based, as Premiere shows them.
 */
/** Past this many clips, get_sequence without {fromS, toS} lists only the stretch around the selection
 *  (a 1500-clip timeline is ~250k tokens, re-read on every step). Padding in seconds either side. */
var GCUT_LIST_CAP = 200, GCUT_LIST_PAD_S = 60;

/** The selection's span padded by GCUT_LIST_PAD_S, in ticks, or null when the listing should stay whole.
 *  A long sequence with nothing selected (cut clips come back unselected) gives {none: true}: no clips listed. */
function gcutListWindow(tracks) {
    var total = 0, lo = null, hi = null, t, i;
    for (t = 0; t < tracks.length; t++) {
        var items = gcutItems(tracks[t].track);
        total += items.length;
        for (i = 0; i < items.length; i++) {
            if (!(typeof items[i].isSelected === "function" && items[i].isSelected())) continue;
            var s = gcutT(items[i].start), e = gcutT(items[i].end);
            if (lo === null || s < lo) lo = s;
            if (hi === null || e > hi) hi = e;
        }
    }
    if (total <= GCUT_LIST_CAP) return null;
    if (lo === null) return { none: true, total: total };
    return { fromT: Math.max(0, lo - GCUT_LIST_PAD_S * GCUT_TICKS), toT: hi + GCUT_LIST_PAD_S * GCUT_TICKS, total: total };
}

function gcutToolGetSequence(argsJson) {
    try {
        var args = gcutParse(argsJson) || {};
        var seq = gcutSequence(), clock = gcutClock(seq), tracks = gcutTracks(seq), t, i;
        var fromT = typeof args.fromS === "number" ? args.fromS * GCUT_TICKS : null;
        var toT = typeof args.toS === "number" ? args.toS * GCUT_TICKS : null;
        var win = fromT === null && toT === null ? gcutListWindow(tracks) : null;
        if (win && !win.none) { fromT = win.fromT; toT = win.toT; }
        var out = { sequenceId: gcutSeqId(seq), name: String(seq.name || ""), fps: Math.round(clock.fps * 1000) / 1000,
                    durationS: gcutSeqEndT(seq) / GCUT_TICKS, tracks: [], clips: [], markers: [], selection: [] };
        for (t = 0; t < tracks.length; t++) {
            var tr = tracks[t], kind = tr.audio ? "audio" : "video";
            out.tracks.push({ kind: kind, index: tr.index + 1, name: String(tr.track.name || ""),
                              muted: typeof tr.track.isMuted === "function" ? !!tr.track.isMuted() : false });
            var items = gcutItems(tr.track);
            for (i = 0; i < items.length; i++) {
                var it = items[i], s = gcutT(it.start), e = gcutT(it.end);
                if ((win && win.none) || (fromT !== null && e <= fromT) || (toT !== null && s >= toT)) continue;
                var id = gcutClipId(kind, tr.index, it), sel = typeof it.isSelected === "function" && !!it.isSelected();
                out.clips.push({ id: id, track: tr.label, name: String(it.name), startS: s / GCUT_TICKS, endS: e / GCUT_TICKS,
                                 inS: gcutClipInS(kind, it, clock), source: gcutSource(it), selected: sel, enabled: it.disabled !== true,
                                 effects: gcutClipEffects(kind, it), speed: gcutSpeed(it) });
                if (sel) out.selection.push(id);
            }
        }
        var marks = gcutMarkerList(seq);
        for (i = 0; i < marks.length; i++) {
            var rec = gcutMarkerRecord(marks[i]);
            if ((fromT !== null && rec.endS * GCUT_TICKS < fromT) || (toT !== null && rec.startS * GCUT_TICKS >= toT)) continue;
            out.markers.push(rec);
        }
        if (win && win.none) {
            out.listed = { fromS: null, toS: null, clips: 0, totalClips: win.total,
                           note: "Nothing is selected and the sequence has " + win.total + " clips, so none are listed. " +
                                 "Pass fromS/toS to list a stretch." };
        } else if (win) {
            out.listed = { fromS: win.fromT / GCUT_TICKS, toS: win.toT / GCUT_TICKS, clips: out.clips.length, totalClips: win.total,
                           note: "Only the clips and markers within " + GCUT_LIST_PAD_S + " s of the selection are listed; the sequence has " +
                                 win.total + " clips. Pass fromS/toS to list another stretch." };
        }
        return gcutOk(out);
    } catch (e) {
        return gcutFail(e);
    }
}

// ── act tools ───────────────────────────────────────────────────────────────────────

/** Refuse unless `sequenceId` (from get_sequence) is the active sequence's. */
function gcutSameSequence(seq, sequenceId) {
    if (sequenceId === undefined || sequenceId === null || String(sequenceId) !== gcutSeqId(seq)) {
        throw new Error("A different sequence is open than the one you read. Call get_sequence again.");
    }
}

function gcutIsTime(v) { return typeof v === "number" && isFinite(v); }

/**
 * args: { sequenceId, markers: [{atS, endS?, name, comments?, colour?}] } — sequence markers, times
 * in seconds on the sequence, colour Premiere's index 0-7. All are checked before any is made; if
 * making one fails, those already made are deleted. Returns { ok, created: [ids], undo: { kind:
 * "markers", sequenceId, markers: [{id, startS, endS, name, comments, colour}] } }.
 */
function gcutToolAddMarkers(argsJson) {
    var seq, created = [], k;
    try {
        var args = gcutParse(argsJson) || {};
        seq = gcutSequence();
        gcutSameSequence(seq, args.sequenceId);
        var list = args.markers, endS = gcutSeqEndT(seq) / GCUT_TICKS, i, x;
        if (!gcutIsArray(list) || !list.length) throw new Error("Give at least one marker.");
        for (i = 0; i < list.length; i++) {
            x = list[i] || {};
            var n = "Marker " + (i + 1);
            if (!gcutIsTime(x.atS) || x.atS < 0 || x.atS > endS) throw new Error(n + ": atS must be a time between 0 and " + endS + " s (the sequence's end).");
            if (x.endS !== undefined && x.endS !== null && (!gcutIsTime(x.endS) || x.endS < x.atS || x.endS > endS)) {
                throw new Error(n + ": endS must be a time between its atS and " + endS + " s (the sequence's end).");
            }
            if (typeof x.name !== "string" || !x.name) throw new Error(n + " needs a name.");
            if (x.colour !== undefined && x.colour !== null && !(typeof x.colour === "number" && x.colour >= 0 && x.colour <= 7 && Math.floor(x.colour) === x.colour)) {
                throw new Error(n + ": colour must be one of Premiere's marker colours, 0-7.");
            }
        }
        var recs = [], ids = [];
        try {
            for (i = 0; i < list.length; i++) {
                x = list[i];
                var m = seq.markers.createMarker(x.atS);
                if (!m) throw new Error("Premiere didn't make marker " + (i + 1) + ".");
                created.push(m);
                m.name = x.name;
                if (typeof x.comments === "string") m.comments = x.comments;
                if (gcutIsTime(x.endS)) m.end = x.endS;
                if (typeof x.colour === "number") m.setColorByIndex(x.colour);
                recs.push(gcutMarkerRecord(m));
                ids.push(recs[i].id);
            }
        } catch (inner) {
            for (k = created.length - 1; k >= 0; k--) {
                try { seq.markers.deleteMarker(created[k]); } catch (ignored) { /* best effort */ }
            }
            throw inner;
        }
        return gcutOk({ ok: true, created: ids, undo: { kind: "markers", sequenceId: gcutSeqId(seq), markers: recs } });
    } catch (e) {
        return gcutFail(e);
    }
}

/** True if marker record `now` still says what `was` recorded (times to half a frame). */
function gcutSameMarker(now, was, clock) {
    return gcutNear(now.startS, was.startS, clock.frameS / 2) && gcutNear(now.endS, was.endS, clock.frameS / 2) &&
        now.name === was.name && now.comments === was.comments && now.colour === was.colour;
}

/**
 * Undo an add_markers: every recorded marker must still be exactly as recorded, then all of them go.
 * None of them left: already undone. Some gone or any changed: refused, nothing deleted. A record
 * with no markers is refused as incomplete. check: run every refusal, delete nothing, and return
 * { ok: true, wouldUndo: true } when the real undo would go ahead.
 */
function gcutUndoMarkers(seq, record, clock, check) {
    if (!gcutIsArray(record.markers) || !record.markers.length) throw new Error("This undo record is incomplete.");
    var now = gcutMarkerList(seq), live = [], gone = 0, changed = [], recs = record.markers, i, j;
    for (i = 0; i < recs.length; i++) {
        var m = null;
        for (j = 0; j < now.length; j++) if (String(now[j].guid) === String(recs[i].id)) m = now[j];
        if (!m) { gone++; changed.push(recs[i].name + " is gone"); continue; }
        if (!gcutSameMarker(gcutMarkerRecord(m), recs[i], clock)) changed.push(recs[i].name + " was changed");
        live.push(m);
    }
    if (gone === recs.length) return { ok: true, alreadyUndone: true };
    if (changed.length) throw new Error("These markers were changed by hand since: " + changed.join("; ") + ". Nothing was undone.");
    if (check) return { ok: true, wouldUndo: true };
    for (i = 0; i < live.length; i++) seq.markers.deleteMarker(live[i]);
    return { ok: true };
}

// ── cut_ranges: Apply's engine on chosen clips ─────────────────────────────────────

/** Apply's pre-check refusals, worded for the tool: there is no Analyse or Apply, Claude reads the timeline and calls cut_ranges. */
function gcutToolAdvice(e) {
    return new Error(String(e && e.message ? e.message : e)
        .replace(/since Analyse/g, "since you read the timeline")
        .replace(/\. Analyse again/g, ". Read the timeline again")
        .replace(/Analyse again/g, "read the timeline again")
        .replace(/ to apply\b/g, " to cut")
        .replace(/Apply again/g, "call cut_ranges again"));
}

/**
 * The record Undo needs, as pure data (it survives a panel reload): the cut's place, its cuts, each
 * item as gcutRefind recorded it but without the live TrackItem and ProjectItem, and the others
 * exactly as gcutOthers gave them.
 */
function gcutCutRecord(rec) {
    var items = [], cutsT = [], others = [], i, f, o;
    for (i = 0; i < rec.items.length; i++) {
        f = rec.items[i];
        items.push({ kind: f.kind, trackIndex: f.trackIndex, label: f.label, node: f.node, startT: f.startT, endT: f.endT,
                     inS: f.inS, outS: f.outS, srcFrameS: f.srcFrameS, loose: f.loose, mediaFrameS: f.mediaFrameS, av: f.av });
    }
    for (i = 0; i < rec.cutsT.length; i++) cutsT.push({ startT: rec.cutsT[i].startT, endT: rec.cutsT[i].endT });
    for (i = 0; i < rec.others.length; i++) {
        o = rec.others[i];
        others.push({ label: o.label, t: o.t, start: o.start, end: o.end, inS: o.inS, node: o.node });
    }
    return { kind: "cuts", sequenceId: rec.sequenceId, startT: rec.startT, endT: rec.endT, cutsT: cutsT,
             rebuiltEndT: rec.rebuiltEndT, items: items, others: others };
}

/** The project item with this nodeId, anywhere in the project's bins, or null (measured: a walk of app.project.rootItem). */
function gcutProjectItemByNode(node) {
    var stack = [app.project.rootItem];
    while (stack.length) {
        var it = stack.pop();
        if (!it) continue;
        if (it.nodeId === node) return it;
        if (it.children) for (var k = 0; k < it.children.numItems; k++) stack.push(it.children[k]);
    }
    return null;
}

/** A cut record (gcutCutRecord) back to what Restore's machinery works with: each item with its live project item. */
function gcutRehydrate(record) {
    if (!gcutIsArray(record.items) || !record.items.length || !gcutIsArray(record.cutsT) || !gcutIsArray(record.others)) {
        throw new Error("This undo record is incomplete, so nothing was undone.");
    }
    return { sequenceId: record.sequenceId, startT: record.startT, endT: record.endT, cutsT: record.cutsT,
             rebuiltEndT: record.rebuiltEndT, items: gcutRehydrateItems(record.items, "the cut"), others: record.others };
}

/** Recorded items (gcutCutRecord's fields) with their live project items; refuses one whose source left the project. */
function gcutRehydrateItems(list, what) {
    var items = [], pis = {}, i, x;
    for (i = 0; i < list.length; i++) {
        x = list[i];
        var pi = pis.hasOwnProperty("n" + x.node) ? pis["n" + x.node] : (pis["n" + x.node] = gcutProjectItemByNode(x.node));
        if (!pi) throw new Error(x.label + "'s source isn't in the project any more, so " + what + " can't be undone. Use Premiere's Undo instead.");
        items.push({ kind: x.kind, trackIndex: x.trackIndex, label: x.label, pi: pi, node: x.node, startT: x.startT, endT: x.endT,
                     inS: x.inS, outS: x.outS, srcFrameS: x.srcFrameS, loose: x.loose, mediaFrameS: x.mediaFrameS, av: x.av });
    }
    return items;
}

/**
 * After a cut: { oldId: [newIds] } for every recorded item (found[k], whose id before the cut was
 * oldIds[k]) whose id changed, the new ids being its laid pieces' (gcutClipId, in timeline order) as
 * get_sequence now gives them. An item laid back as one piece at its own start keeps its id and is
 * left out.
 */
function gcutCutIdMap(seq, clock, found, cutsT, oldIds) {
    var map = {}, plan = gcutPlan(found, cutsT), k, p;
    for (k = 0; k < found.length; k++) {
        var f = found[k], track = gcutKindTracks(seq, f.kind)[f.trackIndex], ids = [];
        for (p = 0; p < plan[k].length; p++) {
            var it = gcutLaidAt(track, f, plan[k][p].atT, clock);
            if (it) ids.push(gcutClipId(f.kind, f.trackIndex, it));
        }
        if (ids.length !== 1 || ids[0] !== oldIds[k]) map[oldIds[k]] = ids;
    }
    return map;
}

/**
 * args: { sequenceId, clipIds, ranges: [{fromS, toS}], acceptEffectLoss? } — cut these sequence-time ranges out of the
 * chosen clips (ids from get_sequence), with Apply's engine and guarantees: the clips are found and
 * checked as Apply finds its recorded ones (locked tracks, speed, loose sources, audio from video
 * files), Apply's pre-checks refuse what the rebuild would overwrite, and the cut is all or nothing.
 * The ranges are clipped to the chosen clips' span [earliest start, latest end]. The rebuild drops the
 * clips' effects, so, as Apply makes the user acknowledge them, any on a chosen clip refuse the cut
 * unless acceptEffectLoss is true. Returns { ok,
 * cutCount, clipCount, removedS, crossfades, warning?, idMap (gcutCutIdMap), undo } (undo: gcutCutRecord). Never touches
 * the Apply/Restore stash.
 */
function gcutToolCutRanges(argsJson) {
    try {
        var args = gcutParse(argsJson) || {}, k;
        var seq = gcutSequence(), clock = gcutClock(seq);
        gcutSameSequence(seq, args.sequenceId);
        var chosen = gcutResolveIds(seq, args.clipIds), spec = { items: [] };
        for (k = 0; k < chosen.length; k++) {
            if (!chosen[k].item.projectItem) throw new Error(gcutLabel(chosen[k].kind, chosen[k].trackIndex) + "'s clip can't be cut: it has no source media.");
            spec.items.push({ kind: chosen[k].kind, trackIndex: chosen[k].trackIndex,
                              startTicks: chosen[k].item.start.ticks, endTicks: chosen[k].item.end.ticks });
        }
        var found, span, cutsT;
        try {
            found = gcutRefind(seq, spec, clock);
            span = gcutSpan(found);
            var ranges = gcutIsArray(args.ranges) ? args.ranges : [], cuts = [], startS = span.fromT / GCUT_TICKS;
            for (k = 0; k < ranges.length; k++) {
                var x = ranges[k] || {};
                if (!gcutIsTime(x.fromS) || !gcutIsTime(x.toS)) throw new Error("Range " + (k + 1) + " needs fromS and toS, in seconds on the sequence.");
                cuts.push({ start: x.fromS - startS, end: x.toS - startS });
            }
            cutsT = gcutCutTicks(cuts, span.fromT, clock, span.toT);
            gcutDropsCheck(seq, found, cutsT, clock); // before gcutAudioUnder: it names what lands where
            var vSpan = gcutSpan(found, "video");
            if (vSpan) gcutAudioUnder(seq, spec, vSpan.fromT, vSpan.toT, clock);
            gcutCovers(seq, found, cutsT, clock);
        } catch (pre) {
            throw gcutToolAdvice(pre);
        }
        if (args.acceptEffectLoss !== true) {
            var lost = [];
            for (k = 0; k < chosen.length; k++) {
                var fx = gcutClipEffects(chosen[k].kind, chosen[k].item);
                if (fx.length) lost.push(gcutLabel(chosen[k].kind, chosen[k].trackIndex) + " (" + chosen[k].item.name + "): " + fx.join(", "));
            }
            if (lost.length) {
                throw new Error("Cutting rebuilds the clips from their source, so these effects would be removed: " + lost.join("; ") +
                    ". Nothing was changed. Ask the user; only if they agree, call cut_ranges again with acceptEffectLoss: true.");
            }
        }
        var rebuiltEndT = span.fromT;
        for (k = 0; k < found.length; k++) rebuiltEndT = Math.max(rebuiltEndT, gcutNewEnd(found[k], cutsT));
        var others = gcutOthers(seq, found, span.fromT, span.toT);
        var rec = { sequenceId: gcutSeqId(seq), startT: span.fromT, endT: span.toT, cutsT: cutsT, rebuiltEndT: rebuiltEndT,
                    items: found, others: others };
        var oldIds = [];
        for (k = 0; k < found.length; k++) oldIds.push(gcutClipId(found[k].kind, found[k].trackIndex, found[k].item));
        var r = gcutCutCore(seq, clock, found, cutsT, rec);
        if (!r.ok) throw new Error(gcutCutFailed(seq, clock, r, others).message);
        return gcutOk({ ok: true, cutCount: r.appliedCount, clipCount: r.clipCount, removedS: r.trailingGapS,
                        crossfades: r.crossfades, warning: r.warning, idMap: gcutCutIdMap(seq, clock, found, cutsT, oldIds),
                        undo: gcutCutRecord(rec) });
    } catch (e) {
        return gcutFail(e);
    }
}

/**
 * True if nothing of the cut is left: every recorded item is back at its own original place (same
 * source, start and end), and none of the pieces only the cut made is on the timeline.
 */
function gcutCutGone(seq, rec, clock) {
    var plan = gcutPlan(rec.items, rec.cutsT);
    for (var i = 0; i < rec.items.length; i++) {
        var f = rec.items[i], tracks = gcutKindTracks(seq, f.kind), back = false;
        if (f.trackIndex >= tracks.numTracks) return false;
        var items = gcutItems(tracks[f.trackIndex]);
        for (var j = 0; j < items.length; j++) {
            if (gcutNode(items[j]) === f.node && gcutT(items[j].start) === f.startT && gcutT(items[j].end) === f.endT) back = true;
        }
        if (!back) return false;
        var whole = plan[i].length === 1 && plan[i][0].atT === f.startT && plan[i][0].durT === f.endT - f.startT;
        if (!whole && gcutOursNow(seq, { items: [f], cutsT: rec.cutsT, others: rec.others }, clock).length) return false;
    }
    return true;
}

/**
 * The label of a track holding a cut piece that sits where planned but was slip-edited since (its
 * in point fails gcutInPointOk against the planned srcIn), or null. gcutOursNow matches pieces by
 * place and length only.
 */
function gcutSlipped(seq, rec, plan, clock) {
    var nV = seq.videoTracks.numTracks;
    for (var i = 0; i < rec.items.length; i++) {
        var f = rec.items[i], t = (f.kind === "audio" ? nV : 0) + f.trackIndex;
        var items = gcutItems(gcutKindTracks(seq, f.kind)[f.trackIndex]);
        for (var j = 0; j < items.length; j++) {
            var it = items[j], s = gcutT(it.start), d = gcutT(it.end) - s;
            if (gcutNode(it) !== f.node || gcutKept(rec.others, t, s, f.node)) continue;
            for (var p = 0; p < plan[i].length; p++) {
                if (gcutNear(s, plan[i][p].atT, clock.half) && gcutNear(d, plan[i][p].durT, clock.half) &&
                    !gcutInPointOk(it.inPoint.seconds, plan[i][p].srcIn, f, clock)) return f.label;
            }
        }
    }
    return null;
}

/**
 * Undo a cut_ranges, as Restore undoes an Apply: only if every planned piece is still exactly where
 * the cut laid it (place, length and in point) and nothing new is in the way; then every recorded item goes back to its own
 * original place, checked, with the others left as they were. Already undone (gcutCutGone): says so.
 * A refusal changes nothing; a re-lay that fails puts the cut version back. check: run every
 * refusal (rehydrate, count, slip, in the way, already undone), change nothing, and return
 * { ok: true, wouldUndo: true } when the real undo would go ahead.
 */
function gcutUndoCuts(seq, record, clock, check) {
    var rec = gcutRehydrate(record), marks = [], k;
    if (gcutCutGone(seq, rec, clock)) return { ok: true, alreadyUndone: true };
    var plan = gcutPlan(rec.items, rec.cutsT), want = 0;
    for (k = 0; k < plan.length; k++) want += plan[k].length;
    var ours = gcutOursNow(seq, rec, clock);
    if (ours.length !== want) {
        throw new Error("Some of the cut pieces were moved, trimmed or removed since (" + ours.length + " of " + want +
            " are where the cut left them), so the cut changed since. Nothing was undone; use Premiere's Undo instead.");
    }
    var slipped = gcutSlipped(seq, rec, plan, clock);
    if (slipped) {
        throw new Error("A cut piece on " + slipped + " was slip-edited since (its source in point changed), so the cut changed since. " +
            "Nothing was undone; use Premiere's Undo instead.");
    }
    var span = gcutSpan(rec.items), others = gcutOthers(seq, ours, span.fromT, span.toT);
    var blocked = gcutInTheWay(seq, rec, others, clock);
    if (blocked) throw new Error(blocked);
    if (check) return { ok: true, wouldUndo: true };
    try {
        for (k = 0; k < rec.items.length; k++) {
            var seen = false;
            for (var m = 0; m < marks.length; m++) if (marks[m].node === rec.items[k].node) seen = true;
            if (!seen) marks.push({ pi: rec.items[k].pi, node: rec.items[k].node, inS: rec.items[k].pi.getInPoint().seconds, outS: rec.items[k].pi.getOutPoint().seconds });
        }
        if (!gcutRelayAll(seq, rec, clock, others)) {
            var cutBack = gcutRelay(seq, rec.items, gcutPlan(rec.items, rec.cutsT), clock, others);
            throw new Error(cutBack ? "The original clips didn't go back as expected, so the cut version was put back as it was. Nothing was undone; try again, or use Premiere's Undo."
                : "The original clips didn't go back as expected, and the cut version couldn't be put back either. Use Premiere's Undo.");
        }
        var hit = gcutSnapshotIntact(seq, others, clock);
        if (hit) throw new Error("Undoing the cut changed something on " + hit + ". Use Premiere's Undo.");
        return { ok: true };
    } finally {
        // Always leave the bin items' own in/out marks as they were.
        for (k = 0; k < marks.length; k++) {
            try { gcutSetRange(marks[k].pi, marks[k].inS, marks[k].outS, clock.frameS / 2); } catch (ignored) { /* best effort */ }
        }
    }
}

// ── piece 4: more act tools, each with an exact undo ─────────────────────────────────

/*
 * Measured in Premiere 26.5.2 (2026-10-14, docs/assistant-measurements-2.md) and relied on:
 *   - qeTrack.razor("HH:MM:SS:FF") splits the clip under that frame on that one track (a linked partner
 *     on another track is not split);
 *   - TrackItem.disabled reads and sets a clip's on/off;
 *   - trackItem.move(offset) moved that item only (its linked partner stayed), but on 2026-10-15 it blocked
 *     Premiere forever (V3 Camera A by +3 s): nothing calls it; close_gaps and move_clips lay clips again;
 *   - remove(false, false) deletes without shifting anything; a ripple remove respects other tracks, so
 *     close_gaps moves the clips itself.
 * Every act tool returns { ok, ..., idMap, undo }: idMap { oldId: [newIds] } for every clip whose id
 * changed (moved or split; {} when none did), undo a pure-data record gcutToolUndo takes back.
 */

var GCUT_BY_HAND = "Nothing was undone; use Premiere's Undo instead.";

/** Seconds as a short number for messages (at most 3 decimals). */
function gcutSecText(s) { return String(Math.round(s * 1000) / 1000); }

/** Seconds on the sequence to the nearest whole frame, in ticks. */
function gcutFrameT(s, clock) { return Math.round(s * GCUT_TICKS / clock.tpf) * clock.tpf; }

/** Ticks as "HH:MM:SS:FF" on the sequence's frames (non-drop, at the nominal rate): the form QE's razor takes (measured). */
function gcutTimecode(ticks, clock) {
    var nominal = Math.round(clock.fps), frames = Math.round(ticks / clock.tpf);
    var secs = Math.floor(frames / nominal), ff = frames - secs * nominal;
    function two(n) { return (n < 10 ? "0" : "") + n; }
    return two(Math.floor(secs / 3600)) + ":" + two(Math.floor(secs / 60) % 60) + ":" + two(secs % 60) + ":" + two(ff);
}

/** A clip by place, as a record names it: { kind, trackIndex, label, node, startT, endT }. */
function gcutRef(kind, trackIndex, it) {
    return { kind: kind, trackIndex: trackIndex, label: gcutLabel(kind, trackIndex), node: String(gcutNode(it) || ""),
             startT: gcutT(it.start), endT: gcutT(it.end) };
}

/** The clip a ref names, exactly (track, start, end and source), or null. */
function gcutFindRef(seq, ref) {
    var tracks = gcutKindTracks(seq, ref.kind);
    if (ref.trackIndex < 0 || ref.trackIndex >= tracks.numTracks) return null;
    var items = gcutItems(tracks[ref.trackIndex]);
    for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (gcutT(it.start) === ref.startT && gcutT(it.end) === ref.endT && String(gcutNode(it) || "") === ref.node) return it;
    }
    return null;
}

/** Refuse if any of these ({kind, trackIndex}) sits on a locked track. */
function gcutRefuseLocked(seq, list, verb) {
    for (var i = 0; i < list.length; i++) {
        var track = gcutKindTracks(seq, list[i].kind)[list[i].trackIndex];
        if (track && typeof track.isLocked === "function" && track.isLocked()) {
            throw new Error(gcutLabel(list[i].kind, list[i].trackIndex) + " is locked. Unlock it to " + verb + ".");
        }
    }
}

function gcutEnabled(it) { return it.disabled !== true; }

/**
 * Undo a change of one setting per clip (on/off, volume, speed): record.items [{...ref, before, after}].
 * Every clip must still be exactly where it was, its setting reading `after` (or `before` where the
 * change left it so); all reading `before`: already undone; any other value, or some set back and some
 * not: changed by hand, refused. read(it) gives the setting, write(it, v, x) sets it, same(a, b) compares.
 */
function gcutUndoSettings(seq, record, check, what, read, write, same) {
    var list = record.items, live = [], changed = [], back = [], i;
    if (!gcutIsArray(list) || !list.length) throw new Error("This undo record is incomplete.");
    for (i = 0; i < list.length; i++) {
        var x = list[i], it = gcutFindRef(seq, x);
        if (!it) { changed.push(x.label + "'s clip was moved, trimmed or removed"); continue; }
        var v = read(it), isBefore = same(v, x.before), isAfter = same(v, x.after);
        if (isAfter && !isBefore) live.push({ it: it, x: x });
        else if (isBefore && !isAfter) back.push(x.label + "'s " + what + " was set back");
        else if (!isBefore) changed.push(x.label + "'s " + what + " was changed");
    }
    if (!changed.length && !live.length) return { ok: true, alreadyUndone: true };
    if (changed.length || back.length) throw new Error("These clips were changed by hand since: " + changed.concat(back).join("; ") + ". " + GCUT_BY_HAND);
    if (check) return { ok: true, wouldUndo: true };
    for (i = 0; i < live.length; i++) write(live[i].it, live[i].x.before, live[i].x);
    for (i = 0; i < live.length; i++) {
        if (!same(read(live[i].it), live[i].x.before)) throw new Error("Premiere didn't take back " + live[i].x.label + "'s " + what + ". Use Premiere's Undo.");
    }
    return { ok: true };
}

// ── set_clip_enabled ──────────────────────────────────────────────────────────────────

/**
 * args: { sequenceId, clipIds, enabled } — switch the chosen clips on (true) or off (false), as the
 * timeline's Enable does. Returns { ok, changed (how many weren't that way already), idMap: {},
 * undo: { kind: "enabled", sequenceId, items: [{kind, trackIndex, label, node, startT, endT, before, after}] } }.
 */
function gcutToolSetClipEnabled(argsJson) {
    try {
        var args = gcutParse(argsJson) || {}, k;
        var seq = gcutSequence();
        gcutSameSequence(seq, args.sequenceId);
        if (typeof args.enabled !== "boolean") throw new Error("enabled must be true or false.");
        var chosen = gcutResolveIds(seq, args.clipIds), items = [], changed = 0;
        gcutRefuseLocked(seq, chosen, "switch clips off or on");
        for (k = 0; k < chosen.length; k++) {
            var x = gcutRef(chosen[k].kind, chosen[k].trackIndex, chosen[k].item);
            x.before = gcutEnabled(chosen[k].item); x.after = args.enabled;
            if (x.before !== x.after) changed++;
            items.push(x);
        }
        for (k = 0; k < chosen.length; k++) chosen[k].item.disabled = !args.enabled;
        for (k = 0; k < chosen.length; k++) {
            if (gcutEnabled(chosen[k].item) !== args.enabled) {
                for (var j = 0; j < chosen.length; j++) { try { chosen[j].item.disabled = !items[j].before; } catch (ignored) { /* best effort */ } }
                throw new Error("Premiere didn't switch " + items[k].label + "'s clip " + (args.enabled ? "on" : "off") + ". Nothing was changed.");
            }
        }
        return gcutOk({ ok: true, changed: changed, idMap: {}, undo: { kind: "enabled", sequenceId: gcutSeqId(seq), items: items } });
    } catch (e) {
        return gcutFail(e);
    }
}

// ── moves: close_gaps and move_clips, and their undo ─────────────────────────────────

/*
 * Real Premiere 26.5.2 (2026-10-15) blocked forever inside trackItem.move(Time) (V3 Camera A moved by +3 s;
 * +2 s had worked once; Premiere had to be restarted twice), so nothing here calls it. A move takes each clip
 * off and lays it again at its new place from its own source, with Restore's machinery (gcutLayAll,
 * gcutVerifyItems, gcutRelay): all or nothing, the bin items' own in/out marks always restored, a clip that
 * was switched off laid off again. Laying again rebuilds from the source, so (as cut_ranges) a clip's effects
 * refuse the move unless the caller accepts losing them (gcutMoveEffects), a retimed clip is refused, and
 * what Premiere drops along with a lay (a video clip's sound, a video file's picture: gcutDropsCheck's
 * rules) is refused where it would cover a clip that stays (gcutMoveDropsCheck).
 */

/**
 * The clips to move ([{kind, trackIndex, item, target}]) as gcutRefind records them, each with its target
 * start (ticks), name, on/off and id. Refuses, changing nothing, a clip with no source media or one that
 * isn't at 100% speed: neither can be laid again as it was. `tail` ends each refusal.
 */
function gcutMovers(seq, list, clock, tail) {
    var spec = { items: [] }, k;
    for (k = 0; k < list.length; k++) {
        var x = list[k], label = gcutLabel(x.kind, x.trackIndex);
        if (!x.item.projectItem) throw new Error(label + "'s clip (" + x.item.name + ") has no source media, so Genius Cut can't lay it again at its new place. " + tail);
        if (Math.abs(gcutSpeed(x.item) - 1) > 1e-6) throw new Error(label + "'s clip (" + x.item.name + ") isn't at 100% speed, so laying it again would change it. " + tail);
        spec.items.push({ kind: x.kind, trackIndex: x.trackIndex, startTicks: x.item.start.ticks, endTicks: x.item.end.ticks });
    }
    var found = gcutRefind(seq, spec, clock);
    for (k = 0; k < found.length; k++) {
        found[k].target = list[k].target; found[k].name = String(list[k].item.name);
        found[k].enabled = gcutEnabled(list[k].item); found[k].oldId = gcutClipId(found[k].kind, found[k].trackIndex, list[k].item);
    }
    return found;
}

/** Refuse, unless accept is true, movers with effects: laying them again from source removes those (as cut_ranges). */
function gcutMoveEffects(found, accept, tail) {
    if (accept === true) return;
    var lost = [];
    for (var k = 0; k < found.length; k++) {
        var fx = gcutClipEffects(found[k].kind, found[k].item);
        if (fx.length) lost.push(found[k].label + " (" + found[k].name + "): " + fx.join(", "));
    }
    if (lost.length) throw new Error("Moving lays the clips again from their source, so these effects would be removed: " + lost.join("; ") + ". " + tail);
}

/**
 * The first clip of a mover's track (one that isn't itself moving) the mover's target would overlap, as
 * { mover, hit (the item) }, or null; two movers landing on each other count too. Movers: [{item, kind,
 * trackIndex, label, name, startT, endT, target}].
 */
function gcutMoveCollision(seq, movers, clock) {
    for (var m = 0; m < movers.length; m++) {
        var a = movers[m], dur = gcutMoveDur(a), items = gcutItems(gcutKindTracks(seq, a.kind)[a.trackIndex]);
        for (var i = 0; i < items.length; i++) {
            var it = items[i], s = gcutT(it.start), e = gcutT(it.end), moving = null;
            for (var k = 0; k < movers.length; k++) {
                if (movers[k].kind === a.kind && movers[k].trackIndex === a.trackIndex && movers[k].startT === s) moving = movers[k];
            }
            if (moving === a) continue;
            if (moving) { s = moving.target; e = moving.target + gcutMoveDur(moving); }
            if (gcutOverlaps(a.target, a.target + dur, s, e, clock)) return { mover: a, hit: it };
        }
    }
    return null;
}

/**
 * gcutDropsCheck's rules at the movers' new places: laying a video clip again drops its sound on A(same number),
 * laying audio from a video file (`av`) drops its picture on V(same number) (measured). Refuse, before anything
 * changes, a drop over a clip that stays (where a mover lands, it counts at its new place): a video clip's sound
 * may only land on clips that move too; audio from a video file's picture only on its own video, moving with it
 * in sync (gcutOwnSound). The one exception: a clip that stays and is exactly what the drop lays (gcutDropIsSame).
 * `advice` follows the reason; `tail` ends every refusal.
 */
function gcutMoveDropsCheck(seq, found, clock, advice, tail) {
    for (var f = 0; f < found.length; f++) {
        var x = found[f], other = x.kind === "audio" ? "video" : "audio";
        if (x.kind === "audio" && !x.av) continue;
        var fromT = x.target, toT = x.target + gcutMoveDur(x), tracks = gcutKindTracks(seq, other), there = gcutLabel(other, x.trackIndex);
        if (x.trackIndex >= tracks.numTracks) {
            if (x.kind === "video") continue;
            throw new Error(x.label + "'s clip comes from a video file, and Premiere drops its picture onto " + there +
                " whenever it's laid again, but this sequence has no " + there + ". " + tail);
        }
        var items = gcutItems(tracks[x.trackIndex]);
        for (var i = 0; i < items.length; i++) {
            var it = items[i], s = gcutT(it.start), e = gcutT(it.end), rec = gcutRecordedAt(found, other, x.trackIndex, s);
            if (rec) { s = rec.target; e = rec.target + gcutMoveDur(rec); }
            if (!gcutOverlaps(s, e, fromT, toT, clock)) continue;
            if (!rec && gcutDropIsSame(x, it, other, clock)) continue;
            if (x.kind === "video") {
                if (rec) continue;
                throw new Error("Laying " + x.label + "'s clip again at its new place also drops its own sound onto " + there + ", over " + it.name +
                    " there. " + advice + tail);
            }
            if (!rec) {
                throw new Error("Laying " + x.label + "'s clip again at its new place also drops its picture onto " + there + ", over " + it.name +
                    " there. " + advice + tail);
            }
            if (rec.node !== x.node) {
                throw new Error(x.label + "'s audio and " + there + "'s video come from different files, and laying the audio again drops its own picture onto " +
                    there + " there. " + tail);
            }
            if (!gcutOwnSound(x, rec, clock)) {
                throw new Error(x.label + "'s audio comes from the same file as " + there + "'s video but " + gcutOffsetWhy(x, rec, clock) +
                    ", so Genius Cut can't lay both again on these tracks without changing your sync. " + tail);
            }
            if (!gcutInSync(x, rec, clock)) gcutQeTrack("audio", x.trackIndex);
        }
    }
}

/** A mover's length once moved: its own, or (moveDurT) the length it had before an earlier move snapped it. */
function gcutMoveDur(f) { return typeof f.moveDurT === "number" ? f.moveDurT : f.endT - f.startT; }

/**
 * True if clip `it` (of kind `kind`, staying where it is) is exactly what laying mover x at its target drops
 * there: x's own sound or picture, same source, place and length, in sync, switched on and without effects.
 * The drop replaces it with the same clip (undoing a move of a video clip without its own sound, back over
 * that sound). Anything else under a drop is refused.
 */
function gcutDropIsSame(x, it, kind, clock) {
    if (String(gcutNode(it) || "") !== String(x.node) || !gcutEnabled(it) || gcutClipEffects(kind, it).length) return false;
    if (!gcutNear(gcutT(it.start), x.target, clock.half) || !gcutNear(gcutT(it.end), x.target + gcutMoveDur(x), clock.half)) return false;
    return gcutNear(gcutClipInS(kind, it, clock), x.inS, clock.frameS / 2 + gcutSlackS(x));
}

/** Each mover's one piece: the whole clip, from its own in point (gcutWhole), at its target. */
function gcutMovePlan(found) {
    var plan = [];
    for (var k = 0; k < found.length; k++) {
        var f = found[k];
        plan.push([{ fromT: f.startT, durT: gcutMoveDur(f), atT: f.target, srcIn: gcutWhole(f)[0].srcIn }]);
    }
    return plan;
}

/** The stretch the movers cover, before and after the move: { fromT, toT }. */
function gcutMoveSpan(found) {
    var span = gcutSpan(found);
    for (var k = 0; k < found.length; k++) {
        span.fromT = Math.min(span.fromT, found[k].target);
        span.toT = Math.max(span.toT, found[k].target + gcutMoveDur(found[k]));
    }
    return span;
}

/** The bin items' own in/out marks for these items, once per source: [{pi, node, inS, outS}]. */
function gcutMarks(items) {
    var marks = [];
    for (var k = 0; k < items.length; k++) {
        var seen = false;
        for (var m = 0; m < marks.length; m++) if (marks[m].node === items[k].node) seen = true;
        if (!seen) marks.push({ pi: items[k].pi, node: items[k].node, inS: items[k].pi.getInPoint().seconds, outS: items[k].pi.getOutPoint().seconds });
    }
    return marks;
}

/** Set the bin items' own marks back (gcutMarks), best effort. */
function gcutMarksBack(marks, clock) {
    for (var k = 0; k < marks.length; k++) {
        try { gcutSetRange(marks[k].pi, marks[k].inS, marks[k].outS, clock.frameS / 2); } catch (ignored) { /* best effort */ }
    }
}

/** Switch each item laid by plan (one piece each) off again where it was off; the label of one Premiere didn't switch, or null. */
function gcutOffAgain(seq, items, plan, clock) {
    for (var k = 0; k < items.length; k++) {
        if (items[k].enabled !== false) continue;
        var it = gcutLaidAt(gcutKindTracks(seq, items[k].kind)[items[k].trackIndex], items[k], plan[k][0].atT, clock);
        if (it) { try { it.disabled = true; } catch (ignored) { /* checked below */ } }
        if (!it || gcutEnabled(it)) return items[k].label;
    }
    return null;
}

/**
 * Move every mover (gcutMovers, each with its target): take them off, lay each whole at its target from its
 * own source, and check each landed exactly (place, length, in point), nothing stray is left and nothing else
 * changed. All or nothing: any failure lays every mover back at its own place (gcutRelay over the move's
 * span) and throws, saying whether that worked (`nothingWas` ends the message when it did). Returns the plan;
 * each mover gets landedT and landedEndT, where it now is (its target, to within half a frame).
 */
function gcutRelocate(seq, clock, found, nothingWas) {
    var plan = gcutMovePlan(found), span = gcutMoveSpan(found), k;
    var others = gcutOthers(seq, found, span.fromT, span.toT), marks = gcutMarks(found);
    try {
        try {
            for (k = 0; k < found.length; k++) found[k].item.remove(false, false);
            gcutRemoveRange(seq, gcutNodes(found), span.fromT, span.toT, clock, others); // linked partners some builds leave behind
            gcutLayAll(seq, found, plan, span.fromT, span.toT, clock, others);
            for (k = 0; k < found.length; k++) {
                if (gcutVerifyItems(seq, found[k], plan[k], clock)) throw new Error("A clip on " + found[k].label + " didn't land where expected");
            }
            var stray = gcutStrayLeft(seq, found, plan, span.fromT, span.toT, clock, others);
            if (stray) throw new Error("Something Premiere dropped along with a clip couldn't be removed from " + stray.label);
            var hit = gcutSnapshotIntact(seq, others, clock);
            if (hit) throw new Error("Laying the clips again changed something on " + hit);
            var on = gcutOffAgain(seq, found, plan, clock);
            if (on) throw new Error("Premiere didn't switch " + on + "'s clip off again");
            // Where each landed, read back: a lay snaps to the sequence's frames, which a clip off them wasn't on.
            for (k = 0; k < found.length; k++) {
                var laid = gcutLaidAt(gcutKindTracks(seq, found[k].kind)[found[k].trackIndex], found[k], found[k].target, clock);
                found[k].landedT = gcutT(laid.start); found[k].landedEndT = gcutT(laid.end);
            }
            return plan;
        } catch (inner) {
            var back = false, whole = [];
            for (k = 0; k < found.length; k++) whole.push(gcutWhole(found[k]));
            try {
                back = gcutRelaySpan(seq, found, whole, span, clock, others) && !gcutSnapshotIntact(seq, others, clock) && !gcutOffAgain(seq, found, whole, clock);
            } catch (ignored) { back = false; }
            throw new Error(inner.message + (back ? ", so every clip was put back. " + nothingWas : ", and not every clip could be put back. Use Premiere's Undo."));
        }
    } finally {
        gcutMarksBack(marks, clock);
    }
}

/**
 * The record of done movers (gcutRelocate), pure data: each as gcutCutRecord keeps an item, with its name,
 * on/off, where it was ([fromT, fromT + durT]) and where it is now ([toT, toEndT]): [{kind, trackIndex, label,
 * name, node, fromT, durT, toT, toEndT, inS, outS, srcFrameS, loose, mediaFrameS, av, enabled}].
 */
function gcutMoveRecord(found) {
    var out = [];
    for (var k = 0; k < found.length; k++) {
        var m = found[k];
        out.push({ kind: m.kind, trackIndex: m.trackIndex, label: m.label, name: m.name, node: m.node, fromT: m.startT, durT: m.endT - m.startT,
                   toT: m.landedT, toEndT: m.landedEndT, inS: m.inS, outS: m.outS, srcFrameS: m.srcFrameS, loose: m.loose, mediaFrameS: m.mediaFrameS,
                   av: m.av, enabled: m.enabled });
    }
    return out;
}

/** { oldId: [newId] } for every done mover, the new id read from the timeline. */
function gcutMoveIdMap(seq, found) {
    var map = {};
    for (var k = 0; k < found.length; k++) {
        var m = found[k], it = gcutFindRef(seq, { kind: m.kind, trackIndex: m.trackIndex, node: m.node, startT: m.landedT, endT: m.landedEndT });
        if (it) map[m.oldId] = [gcutClipId(m.kind, m.trackIndex, it)];
    }
    return map;
}

/**
 * args: { sequenceId, clipIds, acceptEffectLoss? } — close the gaps between the chosen clips: the stretches
 * inside their span that none of them covers. Every clip on EVERY track starting after a gap moves left by the
 * gaps before it, keeping everything after in step: each is taken off and laid again at its new place from its
 * own source (gcutRelocate; never trackItem.move, which hung Premiere). Refuses, moving nothing: no gap; a clip
 * on any track sitting in a gap (it would need cutting); a locked track with a clip to move; a move that would
 * overlap a clip; a clip to move with no source or not at 100% speed; one with effects, unless acceptEffectLoss
 * is true; a drop over a clip that stays (gcutMoveDropsCheck). Returns { ok, gapCount, closedS, movedCount,
 * idMap (every moved clip), undo: { kind: "moves", sequenceId, moves (gcutMoveRecord) } }.
 */
function gcutToolCloseGaps(argsJson) {
    try {
        var args = gcutParse(argsJson) || {}, k, t, i, tail = "Nothing was moved.";
        var seq = gcutSequence(), clock = gcutClock(seq);
        gcutSameSequence(seq, args.sequenceId);
        var chosen = gcutResolveIds(seq, args.clipIds), ivs = [], gaps = [], closedT = 0;
        for (k = 0; k < chosen.length; k++) ivs.push({ s: gcutT(chosen[k].item.start), e: gcutT(chosen[k].item.end) });
        ivs.sort(function (a, b) { return a.s - b.s; });
        var cursor = ivs[0].e;
        for (k = 1; k < ivs.length; k++) {
            if (ivs[k].s > cursor + clock.half) { gaps.push({ startT: cursor, endT: ivs[k].s }); closedT += ivs[k].s - cursor; }
            cursor = Math.max(cursor, ivs[k].e);
        }
        if (!gaps.length) throw new Error("There's no gap between the chosen clips, so nothing was moved.");
        var tracks = gcutTracks(seq), list = [];
        for (t = 0; t < tracks.length; t++) {
            var items = gcutItems(tracks[t].track), kind = tracks[t].audio ? "audio" : "video";
            for (i = 0; i < items.length; i++) {
                var s = gcutT(items[i].start), e = gcutT(items[i].end);
                for (k = 0; k < gaps.length; k++) {
                    if (gcutOverlaps(s, e, gaps[k].startT, gaps[k].endT, clock)) {
                        throw new Error(items[i].name + " on " + tracks[t].label + " sits in the gap at " + gcutClockText(gaps[k].startT) +
                            ", so closing it would need that clip cut or moved. Nothing was moved.");
                    }
                }
                var shift = gcutRemovedBefore(gaps, s);
                if (shift > clock.half) list.push({ kind: kind, trackIndex: tracks[t].index, item: items[i], target: s - shift });
            }
        }
        gcutRefuseLocked(seq, list, "close the gaps");
        var found = gcutMovers(seq, list, clock, tail);
        var hit = gcutMoveCollision(seq, found, clock);
        if (hit) throw new Error("Closing the gaps would land " + hit.mover.name + " on " + hit.hit.name + " on " + hit.mover.label + ", so nothing was moved.");
        gcutMoveEffects(found, args.acceptEffectLoss, tail + " Ask the user; only if they agree, call close_gaps again with acceptEffectLoss: true.");
        gcutMoveDropsCheck(seq, found, clock, "", tail);
        gcutRelocate(seq, clock, found, "Nothing was changed.");
        return gcutOk({ ok: true, gapCount: gaps.length, closedS: closedT / GCUT_TICKS, movedCount: found.length,
                        idMap: gcutMoveIdMap(seq, found), undo: { kind: "moves", sequenceId: gcutSeqId(seq), moves: gcutMoveRecord(found) } });
    } catch (e) {
        return gcutFail(e);
    }
}

/**
 * Undo a "moves" record (close_gaps, move_clips): lay every moved clip again at its old place, from its own
 * source (gcutRelocate), all or nothing. Every one must still be exactly where the move left it (place, length,
 * source and in point; none of them: already undone, when all are back where they were); laying them back
 * must not land on anything, drop anything over a clip that stays, nor touch a locked track; every source must
 * still be in the project. check: every refusal, changing nothing.
 */
function gcutUndoMoves(seq, record, clock, check) {
    var moves = record.moves, live = [], atOld = 0, k, m, ref;
    if (!gcutIsArray(moves) || !moves.length) throw new Error("This undo record is incomplete.");
    for (k = 0; k < moves.length; k++) {
        if (typeof moves[k].inS !== "number" || typeof moves[k].durT !== "number" || typeof moves[k].toEndT !== "number") {
            throw new Error("This move was made by an earlier Genius Cut, which kept too little to lay it back. " + GCUT_BY_HAND);
        }
    }
    for (k = 0; k < moves.length; k++) {
        m = moves[k];
        ref = { kind: m.kind, trackIndex: m.trackIndex, node: m.node, startT: m.toT, endT: m.toEndT };
        var it = gcutFindRef(seq, ref);
        live.push(it);
        if (!it) {
            ref.startT = m.fromT; ref.endT = m.fromT + m.durT;
            if (gcutFindRef(seq, ref)) atOld++;
        }
    }
    if (atOld === moves.length) return { ok: true, alreadyUndone: true };
    var there = 0;
    for (k = 0; k < live.length; k++) if (live[k]) there++;
    if (there !== moves.length) {
        throw new Error("Some of the moved clips were moved, trimmed or removed by hand since (" + there + " of " + moves.length +
            " are where the move left them). " + GCUT_BY_HAND);
    }
    for (k = 0; k < moves.length; k++) {
        if (!gcutInPointOk(live[k].inPoint.seconds, gcutWhole(moves[k])[0].srcIn, moves[k], clock)) {
            throw new Error(moves[k].label + "'s moved clip was slip-edited since (its source in point changed). " + GCUT_BY_HAND);
        }
    }
    var items = gcutRehydrateItems(moves, "the move"), found = [];
    for (k = 0; k < items.length; k++) {
        var f = items[k];
        f.item = live[k]; f.startT = moves[k].toT; f.endT = moves[k].toEndT; f.target = moves[k].fromT; f.moveDurT = moves[k].durT;
        f.name = moves[k].name; f.enabled = gcutEnabled(live[k]);
        found.push(f);
    }
    gcutRefuseLocked(seq, found, "undo");
    var hit = gcutMoveCollision(seq, found, clock);
    if (hit) throw new Error("Moving the clips back would land " + hit.mover.name + " on " + hit.hit.name + " on " + hit.mover.label + ". " + GCUT_BY_HAND);
    gcutMoveDropsCheck(seq, found, clock, "", GCUT_BY_HAND);
    if (check) return { ok: true, wouldUndo: true };
    gcutRelocate(seq, clock, found, "Nothing was undone.");
    return { ok: true };
}

// ── split_at, and the splits switch_angle makes ──────────────────────────────────────

/** The QE track of this kind and index (app.enableQE, measured); refuses when QE isn't there. Used by split_at, switch_angle, add_transition and set_speed. */
function gcutQeTrack(kind, trackIndex) {
    var qt = null;
    try {
        app.enableQE();
        var qseq = qe.project.getActiveSequence();
        qt = kind === "audio" ? qseq.getAudioTrackAt(trackIndex) : qseq.getVideoTrackAt(trackIndex);
    } catch (e) { qt = null; }
    if (!qt) throw new Error("Premiere's QE interface isn't available here. Nothing was changed; do it by hand.");
    return qt;
}

/**
 * A split record's clip: { kind, trackIndex, label, node, startT, endT, inS (gcutClipInS), enabled, atT: [split
 * times inside it, in order] }. Its pieces, as refs with the in point each must have: [{ref, inS}].
 */
function gcutSplitPieces(c) {
    var cuts = [c.startT].concat(c.atT).concat([c.endT]), out = [];
    for (var k = 0; k + 1 < cuts.length; k++) {
        out.push({ ref: { kind: c.kind, trackIndex: c.trackIndex, label: c.label, node: c.node, startT: cuts[k], endT: cuts[k + 1] },
                   inS: c.inS + (cuts[k] - c.startT) / GCUT_TICKS });
    }
    return out;
}

/**
 * True if clip `it`'s source in point is wantS (a split clip's, or one of its pieces'), read as the cut verify
 * reads a laid piece (gcutInPointOk): Premiere 26.5.2 reports it floored to the sequence's frames, and a loose
 * clip (its own frames don't fit the sequence's, gcutRefind) can sit up to one of its own frames from it (a
 * razored piece's in point isn't on its own frames). Any other clip's must be within half a sequence frame.
 */
function gcutInPointIs(kind, it, wantS, clock) {
    var f = { loose: false, mediaFrameS: 0 };
    if (it.projectItem) {
        var srcFps = kind === "audio" ? gcutMediaFps(it.projectItem) : gcutSourceFps(it.projectItem, clock);
        if (kind === "audio" && srcFps > GCUT_MAX_FRAME_RATE) srcFps = 0;
        if (srcFps > 0 && !gcutFits(srcFps, clock)) f = { loose: true, mediaFrameS: 1 / srcFps };
    }
    if (!f.loose) return gcutNear(it.inPoint.seconds, wantS, clock.frameS / 2);
    return gcutInPointOk(it.inPoint.seconds, wantS, f, clock);
}

/** The live pieces of split clip c, in order, if every one is exactly where the split left it (place, length, source and in point); else null. */
function gcutLivePieces(seq, c, clock) {
    var pieces = gcutSplitPieces(c), live = [];
    for (var k = 0; k < pieces.length; k++) {
        var it = gcutFindRef(seq, pieces[k].ref);
        if (!it || !gcutInPointIs(c.kind, it, pieces[k].inS, clock)) return null;
        live.push(it);
    }
    return live;
}

/** True if split clip c is whole again: one clip at its place, from its in point (gcutInPointIs), on or off as it was. */
function gcutWholeAgain(seq, c, clock) {
    var it = gcutFindRef(seq, c);
    return !!it && gcutInPointIs(c.kind, it, c.inS, clock) && gcutEnabled(it) === c.enabled;
}

/** Join split clip c's pieces back into one: the later pieces go, the first one's end is set back (TrackItem.end, measured). Throws if it isn't whole after. */
function gcutJoin(seq, c, clock) {
    var live = gcutLivePieces(seq, c, clock);
    if (live) {
        for (var k = live.length - 1; k >= 1; k--) live[k].remove(false, false);
        try { live[0].end = gcutTimeFromTicks(c.endT); } catch (e) { /* checked below */ }
        var it = gcutFindRef(seq, c);
        if (it) it.disabled = !c.enabled;
    }
    if (!gcutWholeAgain(seq, c, clock)) throw new Error("Couldn't join " + c.label + "'s pieces back. Use Premiere's Undo.");
}

/** Razor split clip c (a record clip, not yet split at atT) at atT on its own track, and check both pieces are there. */
function gcutRazor(seq, c, atT, clock) {
    gcutQeTrack(c.kind, c.trackIndex).razor(gcutTimecode(atT, clock));
    var left = { kind: c.kind, trackIndex: c.trackIndex, node: c.node, startT: c.startT, endT: atT };
    var right = { kind: c.kind, trackIndex: c.trackIndex, node: c.node, startT: atT, endT: c.endT };
    if (!gcutFindRef(seq, left) || !gcutFindRef(seq, right)) throw new Error("Premiere didn't split " + c.label + "'s clip at " + gcutClockText(atT) + ".");
}

/** A split record clip for chosen clip x ({kind, trackIndex, item}), with no splits yet. */
function gcutSplitClip(x, clock) {
    var c = gcutRef(x.kind, x.trackIndex, x.item);
    c.inS = gcutClipInS(x.kind, x.item, clock); c.enabled = gcutEnabled(x.item); c.atT = [];
    return c;
}

/**
 * Split each record clip at its times (c.wantT, in order), clip after clip. Returns the clips, each with
 * atT as done. If a razor fails, every clip split so far is joined back and the error says so.
 */
function gcutSplitAll(seq, clips, clock) {
    var done = [], k, p;
    try {
        for (k = 0; k < clips.length; k++) {
            var c = clips[k];
            for (p = 0; p < c.wantT.length; p++) {
                var piece = { kind: c.kind, trackIndex: c.trackIndex, label: c.label, node: c.node,
                              startT: p ? c.wantT[p - 1] : c.startT, endT: c.endT };
                if (done[done.length - 1] !== c) done.push(c);
                gcutRazor(seq, piece, c.wantT[p], clock);
                c.atT.push(c.wantT[p]);
            }
        }
    } catch (e) {
        var stuck = [];
        for (k = done.length - 1; k >= 0; k--) {
            if (!done[k].atT.length) continue;
            try { gcutJoin(seq, done[k], clock); } catch (e2) { stuck.push(done[k].label); }
        }
        throw new Error(e.message + (stuck.length ? " " + stuck.join(", ") + " couldn't be joined back: use Premiere's Undo." : " Nothing was changed."));
    }
    return clips;
}

/** { oldId: [ids of its pieces, in order] } for every record clip that was split. */
function gcutSplitIdMap(seq, clips, clock) {
    var map = {};
    for (var k = 0; k < clips.length; k++) {
        var c = clips[k];
        if (!c.atT.length) continue;
        var live = gcutLivePieces(seq, c, clock), ids = [];
        if (live) for (var p = 0; p < live.length; p++) ids.push(gcutClipId(c.kind, c.trackIndex, live[p]));
        map[c.oldId] = ids;
    }
    return map;
}

/** A split record clip as stored: pure data, without the run-time fields. */
function gcutSplitStored(clips) {
    var out = [];
    for (var k = 0; k < clips.length; k++) {
        var c = clips[k];
        out.push({ kind: c.kind, trackIndex: c.trackIndex, label: c.label, node: c.node, startT: c.startT, endT: c.endT,
                   inS: c.inS, enabled: c.enabled, atT: c.atT.slice(0) });
    }
    return out;
}

/**
 * args: { sequenceId, clipIds, atS } — split each chosen clip at atS (to the nearest frame) with QE's razor on
 * its own track (a linked partner that isn't chosen stays whole, measured). Refuses, changing nothing, a
 * time that isn't inside every chosen clip and a locked track. Returns { ok, splitCount, idMap ({ oldId:
 * [oldId, idOfTheSecondPiece] }), undo: { kind: "split", sequenceId, clips: [{kind, trackIndex, label, node,
 * startT, endT, inS, enabled, atT: [t]}] } }.
 */
function gcutToolSplitAt(argsJson) {
    try {
        var args = gcutParse(argsJson) || {}, k;
        var seq = gcutSequence(), clock = gcutClock(seq);
        gcutSameSequence(seq, args.sequenceId);
        if (!gcutIsTime(args.atS)) throw new Error("atS must be a time in seconds on the sequence.");
        var chosen = gcutResolveIds(seq, args.clipIds), atT = gcutFrameT(args.atS, clock), clips = [];
        gcutRefuseLocked(seq, chosen, "split");
        for (k = 0; k < chosen.length; k++) {
            var c = gcutSplitClip(chosen[k], clock);
            if (!(c.startT + clock.half < atT && atT < c.endT - clock.half)) {
                throw new Error(c.label + "'s clip (" + gcutSecText(c.startT / GCUT_TICKS) + "–" + gcutSecText(c.endT / GCUT_TICKS) + " s) doesn't run across " +
                    gcutSecText(args.atS) + " s, so it can't be split there. Nothing was changed.");
            }
            c.wantT = [atT]; c.oldId = gcutClipId(chosen[k].kind, chosen[k].trackIndex, chosen[k].item);
            clips.push(c);
        }
        for (k = 0; k < clips.length; k++) gcutQeTrack(clips[k].kind, clips[k].trackIndex);
        gcutSplitAll(seq, clips, clock);
        return gcutOk({ ok: true, splitCount: clips.length, idMap: gcutSplitIdMap(seq, clips, clock),
                        undo: { kind: "split", sequenceId: gcutSeqId(seq), clips: gcutSplitStored(clips) } });
    } catch (e) {
        return gcutFail(e);
    }
}

/**
 * Undo a "split" (split_at) or "angle" (switch_angle) record: { clips (gcutSplitStored), states?: [{...ref,
 * before, after}] (on/off set on pieces) }. Already undone when every clip is whole again, on or off as it
 * was. Otherwise every piece must be exactly where the split left it, and every state still `after`;
 * then the states go back and the pieces are joined.
 */
function gcutUndoSplits(seq, record, clock, check) {
    var clips = record.clips, states = gcutIsArray(record.states) ? record.states : [], k, whole = 0;
    if (!gcutIsArray(clips) || !clips.length) throw new Error("This undo record is incomplete.");
    for (k = 0; k < clips.length; k++) if (gcutWholeAgain(seq, clips[k], clock)) whole++;
    if (whole === clips.length) return { ok: true, alreadyUndone: true };
    for (k = 0; k < clips.length; k++) {
        if (!gcutLivePieces(seq, clips[k], clock)) throw new Error(clips[k].label + "'s pieces were moved, trimmed, removed or slip-edited since. " + GCUT_BY_HAND);
    }
    var live = [];
    for (k = 0; k < states.length; k++) {
        var it = gcutFindRef(seq, states[k]);
        if (!it) throw new Error(states[k].label + "'s pieces were moved, trimmed, removed or slip-edited since. " + GCUT_BY_HAND);
        if (gcutEnabled(it) !== states[k].after) {
            throw new Error(states[k].label + "'s piece was switched " + (states[k].after ? "off" : "on") + " by hand since. " + GCUT_BY_HAND);
        }
        live.push(it);
    }
    gcutRefuseLocked(seq, clips, "undo");
    if (check) return { ok: true, wouldUndo: true };
    for (k = 0; k < live.length; k++) live[k].disabled = !states[k].before;
    for (k = clips.length - 1; k >= 0; k--) if (clips[k].atT.length) gcutJoin(seq, clips[k], clock);
    return { ok: true };
}

// ── delete_clips ──────────────────────────────────────────────────────────────────────

/**
 * What would be in the way of laying these recorded items back from their source (overwriteClip drops a
 * video file's picture and sound together, measured): a clip that isn't one of them on the track a video
 * item's sound lands on (A of its number), or that audio from a video file's picture lands on (V of its
 * number). Returns { label, there, name, sound } or null.
 */
function gcutRelayBlocker(seq, items, clock) {
    for (var f = 0; f < items.length; f++) {
        var x = items[f], other = x.kind === "audio" ? "video" : "audio";
        if (x.kind === "audio" && !x.av) continue;
        var tracks = gcutKindTracks(seq, other);
        if (x.trackIndex >= tracks.numTracks) continue;
        var list = gcutItems(tracks[x.trackIndex]);
        for (var i = 0; i < list.length; i++) {
            var s = gcutT(list[i].start);
            if (!gcutOverlaps(s, gcutT(list[i].end), x.startT, x.endT, clock) || gcutRecorded(items, other, x.trackIndex, s)) continue;
            return { label: x.label, there: gcutLabel(other, x.trackIndex), name: String(list[i].name), sound: x.kind === "video" };
        }
    }
    return null;
}

/**
 * args: { sequenceId, clipIds } — delete the chosen clips with remove(false, false): nothing slides, and a
 * linked partner that isn't chosen stays (measured). Refuses, changing nothing, a locked track and a clip
 * that isn't at 100% speed (its undo couldn't lay it back as it was). Returns { ok, deleted: [ids], warning?,
 * idMap: {}, undo: { kind: "delete", sequenceId, items } }. The undo lays the clips back from their source,
 * as a cut's undo does: `warning` names effects that wouldn't come back, and a clip whose sound (or picture)
 * would land on a clip that stays, whose delete only Premiere's Undo can take back.
 */
function gcutToolDeleteClips(argsJson) {
    try {
        var args = gcutParse(argsJson) || {}, k;
        var seq = gcutSequence(), clock = gcutClock(seq);
        gcutSameSequence(seq, args.sequenceId);
        var chosen = gcutResolveIds(seq, args.clipIds), spec = { items: [] }, ids = [];
        gcutRefuseLocked(seq, chosen, "delete");
        for (k = 0; k < chosen.length; k++) {
            var label = gcutLabel(chosen[k].kind, chosen[k].trackIndex);
            if (!chosen[k].item.projectItem) throw new Error(label + "'s clip has no source media, so deleting it couldn't be undone. Delete it by hand.");
            if (Math.abs(gcutSpeed(chosen[k].item) - 1) > 1e-6) throw new Error(label + " isn't at 100% speed, so deleting it couldn't be undone exactly. Delete it by hand.");
            spec.items.push({ kind: chosen[k].kind, trackIndex: chosen[k].trackIndex, startTicks: chosen[k].item.start.ticks, endTicks: chosen[k].item.end.ticks });
            ids.push(gcutClipId(chosen[k].kind, chosen[k].trackIndex, chosen[k].item));
        }
        var found = gcutRefind(seq, spec, clock), notes = [], lost = [];
        for (k = 0; k < chosen.length; k++) {
            var fx = gcutClipEffects(chosen[k].kind, chosen[k].item);
            if (fx.length) lost.push(found[k].label + " (" + chosen[k].item.name + "): " + fx.join(", "));
        }
        if (lost.length) notes.push("An undo lays deleted clips back from their source, so these effects wouldn't come back: " + lost.join("; ") + ".");
        var blocker = gcutRelayBlocker(seq, found, clock);
        if (blocker) {
            notes.push("Undoing this delete will need Premiere's Undo: laying " + blocker.label + "'s clip back from its source would also lay its " +
                (blocker.sound ? "sound" : "picture") + " on " + blocker.there + ", over " + blocker.name + " there.");
        }
        var items = gcutCutRecord({ items: found, cutsT: [], others: [] }).items;
        for (k = 0; k < items.length; k++) { items[k].enabled = gcutEnabled(found[k].item); items[k].name = String(found[k].item.name); }
        var span = gcutSpan(found), others = gcutOthers(seq, found, span.fromT, span.toT);
        for (k = 0; k < found.length; k++) found[k].item.remove(false, false);
        for (k = 0; k < items.length; k++) {
            if (gcutFindRef(seq, items[k])) throw new Error(items[k].label + "'s clip didn't come off the timeline. Use Premiere's Undo to put back anything that did.");
        }
        var hit = gcutSnapshotIntact(seq, others, clock);
        if (hit) throw new Error("Deleting also changed something on " + hit + ". Use Premiere's Undo.");
        return gcutOk({ ok: true, deleted: ids, warning: notes.length ? notes.join(" ") : undefined, idMap: {},
                        undo: { kind: "delete", sequenceId: gcutSeqId(seq), items: items } });
    } catch (e) {
        return gcutFail(e);
    }
}

/**
 * Undo a delete: lay every deleted clip back at its own place from its own source (Restore's machinery),
 * on or off as it was. Already undone when every one is back; refused, changing nothing, when only some
 * are, when anything now sits where one was (or where its sound or picture would land), or when a source
 * left the project. A lay that fails takes off what it laid.
 */
function gcutUndoDelete(seq, record, clock, check) {
    var list = record.items, back = 0, k;
    if (!gcutIsArray(list) || !list.length) throw new Error("This undo record is incomplete.");
    for (k = 0; k < list.length; k++) if (gcutFindRef(seq, list[k])) back++;
    if (back === list.length) return { ok: true, alreadyUndone: true };
    if (back) throw new Error("Some of the deleted clips were put back by hand since (" + back + " of " + list.length + "). " + GCUT_BY_HAND);
    for (k = 0; k < list.length; k++) {
        var x = list[k], tracks = gcutKindTracks(seq, x.kind);
        if (x.trackIndex >= tracks.numTracks) throw new Error(x.label + " no longer exists. " + GCUT_BY_HAND);
        var on = gcutItems(tracks[x.trackIndex]);
        for (var i = 0; i < on.length; i++) {
            if (gcutOverlaps(gcutT(on[i].start), gcutT(on[i].end), x.startT, x.endT, clock)) {
                throw new Error("Something was placed on " + x.label + " where a deleted clip was since. " + GCUT_BY_HAND);
            }
        }
    }
    var blocker = gcutRelayBlocker(seq, list, clock);
    if (blocker) {
        throw new Error("Laying " + blocker.label + "'s clip back would also lay its " + (blocker.sound ? "sound" : "picture") + " on " + blocker.there +
            ", over " + blocker.name + " there. " + GCUT_BY_HAND);
    }
    var items = gcutRehydrateItems(list, "the delete"), marks = [];
    gcutRefuseLocked(seq, items, "undo");
    if (check) return { ok: true, wouldUndo: true };
    var span = gcutSpan(items), others = gcutOthers(seq, [], span.fromT, span.toT);
    try {
        for (k = 0; k < items.length; k++) {
            var seen = false;
            for (var m = 0; m < marks.length; m++) if (marks[m].node === items[k].node) seen = true;
            if (!seen) marks.push({ pi: items[k].pi, node: items[k].node, inS: items[k].pi.getInPoint().seconds, outS: items[k].pi.getOutPoint().seconds });
        }
        if (!gcutRelayAll(seq, { items: items }, clock, others)) {
            try { gcutRemoveRange(seq, gcutNodes(items), span.fromT, span.toT, clock, others); } catch (ignored) { /* checked below */ }
            var clean = true;
            for (k = 0; k < list.length; k++) if (gcutFindRef(seq, list[k])) clean = false;
            throw new Error(clean && !gcutSnapshotIntact(seq, others, clock)
                ? "The deleted clips didn't go back as expected, so they were taken off again. Nothing was undone; try again, or use Premiere's Undo."
                : "The deleted clips didn't go back as expected, and what was laid couldn't all be taken off. Use Premiere's Undo.");
        }
        var hit = gcutSnapshotIntact(seq, others, clock);
        if (hit) throw new Error("Undoing the delete changed something on " + hit + ". Use Premiere's Undo.");
        for (k = 0; k < list.length; k++) {
            var it = gcutFindRef(seq, list[k]);
            if (it && list[k].enabled === false) it.disabled = true;
        }
        return { ok: true };
    } finally {
        // Always leave the bin items' own in/out marks as they were.
        for (k = 0; k < marks.length; k++) {
            try { gcutSetRange(marks[k].pi, marks[k].inS, marks[k].outS, clock.frameS / 2); } catch (ignored2) { /* best effort */ }
        }
    }
}

// ── move_clips ────────────────────────────────────────────────────────────────────────

/**
 * args: { sequenceId, clipIds, byS, acceptEffectLoss? } — move each chosen clip along its own track by byS
 * seconds (to the nearest frame; negative moves left): each is taken off and laid again at its new place from
 * its own source (gcutRelocate; never trackItem.move, which hung Premiere), all or nothing. A linked partner
 * moves only when it is chosen too; one that isn't stays where it is, and a move whose drop (its sound, or its
 * picture) would land on it is refused (gcutMoveDropsCheck). Refuses, moving nothing: a move of less than a
 * frame, one before the sequence's start, a locked track, landing on any clip that isn't moving with it, a clip
 * with no source or not at 100% speed, and one with effects unless acceptEffectLoss is true. Returns { ok,
 * movedCount, idMap (every moved clip), undo: { kind: "moves", sequenceId, moves (gcutMoveRecord) } }.
 */
function gcutToolMoveClips(argsJson) {
    try {
        var args = gcutParse(argsJson) || {}, k, tail = "Nothing was moved.";
        var seq = gcutSequence(), clock = gcutClock(seq);
        gcutSameSequence(seq, args.sequenceId);
        if (!gcutIsTime(args.byS)) throw new Error("byS must be a time in seconds (negative moves left).");
        var byT = gcutFrameT(args.byS, clock);
        if (!byT) throw new Error("byS rounds to less than a frame, so nothing would move.");
        var chosen = gcutResolveIds(seq, args.clipIds), list = [];
        gcutRefuseLocked(seq, chosen, "move clips");
        for (k = 0; k < chosen.length; k++) {
            var target = gcutT(chosen[k].item.start) + byT;
            if (target < 0) {
                throw new Error("Moving " + gcutLabel(chosen[k].kind, chosen[k].trackIndex) + "'s clip by " + gcutSecText(args.byS) +
                    " s would put it before the sequence's start. Nothing was moved.");
            }
            list.push({ kind: chosen[k].kind, trackIndex: chosen[k].trackIndex, item: chosen[k].item, target: target });
        }
        var found = gcutMovers(seq, list, clock, tail);
        var hit = gcutMoveCollision(seq, found, clock);
        if (hit) {
            throw new Error("Moving the clips by " + gcutSecText(byT / GCUT_TICKS) + " s would land " + hit.mover.name + " on " + hit.hit.name +
                " on " + hit.mover.label + ". Nothing was moved.");
        }
        gcutMoveEffects(found, args.acceptEffectLoss, tail + " Ask the user; only if they agree, call move_clips again with acceptEffectLoss: true.");
        gcutMoveDropsCheck(seq, found, clock, "Choose that clip too, so both move, or move the clip clear of it. ", tail);
        gcutRelocate(seq, clock, found, "Nothing was changed.");
        return gcutOk({ ok: true, movedCount: found.length, idMap: gcutMoveIdMap(seq, found),
                        undo: { kind: "moves", sequenceId: gcutSeqId(seq), moves: gcutMoveRecord(found) } });
    } catch (e) {
        return gcutFail(e);
    }
}

// ── switch_angle ──────────────────────────────────────────────────────────────────────

/**
 * args: { sequenceId, clipIds (the chosen video clips: the angles), fromS, toS, showTrack (1-based video
 * track) } — for the stretch fromS–toS (to the nearest frames), show showTrack's angle: every chosen clip
 * overlapping the stretch is split at fromS and toS where they fall inside it (QE razor, per track), then its
 * piece inside the stretch is switched off (TrackItem.disabled), except showTrack's, which is switched on.
 * Chosen clips outside the stretch are left as they are; audio isn't touched. Refuses, changing nothing: an
 * audio clip, a showTrack with no chosen clip covering the whole stretch, a locked track. Returns { ok,
 * shown: "V<n>", hidden: [track labels], splitCount, idMap (every split clip: [its pieces' ids, in order]),
 * undo: { kind: "angle", sequenceId, clips (as split_at's), states: [{kind, trackIndex, label, node, startT,
 * endT, before, after}] } }.
 */
function gcutToolSwitchAngle(argsJson) {
    try {
        var args = gcutParse(argsJson) || {}, k;
        var seq = gcutSequence(), clock = gcutClock(seq);
        gcutSameSequence(seq, args.sequenceId);
        if (!gcutIsTime(args.fromS) || !gcutIsTime(args.toS)) throw new Error("fromS and toS must be times in seconds on the sequence.");
        var fromT = gcutFrameT(args.fromS, clock), toT = gcutFrameT(args.toS, clock);
        if (toT <= fromT) throw new Error("toS must be after fromS (at least a frame).");
        var n = args.showTrack;
        if (typeof n !== "number" || n < 1 || Math.floor(n) !== n) throw new Error("showTrack must be a video track number (1 for V1).");
        var chosen = gcutResolveIds(seq, args.clipIds), inRange = [], show = null;
        for (k = 0; k < chosen.length; k++) {
            if (chosen[k].kind !== "video") {
                throw new Error(gcutLabel(chosen[k].kind, chosen[k].trackIndex) + "'s clip is audio: switch_angle works on the chosen video clips. Nothing was changed.");
            }
        }
        for (k = 0; k < chosen.length; k++) {
            var s = gcutT(chosen[k].item.start), e = gcutT(chosen[k].item.end);
            if (!gcutOverlaps(s, e, fromT, toT, clock)) continue;
            inRange.push(chosen[k]);
            if (chosen[k].trackIndex === n - 1 && s <= fromT + clock.half && e >= toT - clock.half) show = chosen[k];
        }
        if (!show) {
            throw new Error("None of the chosen clips on V" + n + " covers " + gcutSecText(args.fromS) + "–" + gcutSecText(args.toS) + " s, so V" + n +
                " can't be shown there. Nothing was changed.");
        }
        gcutRefuseLocked(seq, inRange, "switch angles");
        var clips = [], hidden = [], splits = 0;
        for (k = 0; k < inRange.length; k++) {
            var c = gcutSplitClip(inRange[k], clock);
            c.wantT = [];
            if (c.startT + clock.half < fromT) c.wantT.push(fromT);
            if (toT < c.endT - clock.half) c.wantT.push(toT);
            c.oldId = gcutClipId("video", c.trackIndex, inRange[k].item);
            splits += c.wantT.length;
            if (c.wantT.length) gcutQeTrack("video", c.trackIndex);
            clips.push(c);
            if (c.trackIndex !== n - 1 && ("," + hidden.join(",") + ",").indexOf("," + c.label + ",") < 0) hidden.push(c.label);
        }
        gcutSplitAll(seq, clips, clock);
        var states = [], live = [];
        for (k = 0; k < clips.length; k++) {
            var st = { kind: "video", trackIndex: clips[k].trackIndex, label: clips[k].label, node: clips[k].node,
                       startT: Math.max(clips[k].startT, fromT), endT: Math.min(clips[k].endT, toT) };
            var it = gcutFindRef(seq, st);
            st.after = clips[k].trackIndex === n - 1;
            st.before = it ? gcutEnabled(it) : st.after;
            states.push(st); live.push(it);
        }
        var failed = null;
        for (k = 0; k < live.length; k++) {
            if (live[k]) { try { live[k].disabled = !states[k].after; } catch (ignored) { /* checked below */ } }
            if (!failed && (!live[k] || gcutEnabled(live[k]) !== states[k].after)) failed = states[k].label;
        }
        if (failed) {
            var stuck = [];
            for (k = 0; k < live.length; k++) { if (live[k]) { try { live[k].disabled = !states[k].before; } catch (ignored2) { /* best effort */ } } }
            for (k = clips.length - 1; k >= 0; k--) {
                if (!clips[k].atT.length) continue;
                try { gcutJoin(seq, clips[k], clock); } catch (e2) { stuck.push(clips[k].label); }
            }
            throw new Error("Premiere didn't switch " + failed + "'s piece " + (failed === "V" + n ? "on" : "off") + "." +
                (stuck.length ? " " + stuck.join(", ") + " couldn't be joined back: use Premiere's Undo." : " Nothing was changed."));
        }
        return gcutOk({ ok: true, shown: "V" + n, hidden: hidden, splitCount: splits, idMap: gcutSplitIdMap(seq, clips, clock),
                        undo: { kind: "angle", sequenceId: gcutSeqId(seq), clips: gcutSplitStored(clips), states: states } });
    } catch (e) {
        return gcutFail(e);
    }
}

// ── set_volume ────────────────────────────────────────────────────────────────────────

/** The audio clip's Volume component "Level" property (linear, 0.17783 at 0 dB, measured), or null. */
function gcutLevelParam(it) {
    if (!it || !it.components) return null;
    for (var i = 0; i < it.components.numItems; i++) {
        var c = it.components[i];
        if (c.displayName !== "Volume" || !c.properties) continue;
        for (var j = 0; j < c.properties.numItems; j++) if (c.properties[j].displayName === "Level") return c.properties[j];
    }
    return null;
}

function gcutLevel(it) { var p = gcutLevelParam(it); return p ? Number(p.getValue()) : NaN; }

/** True if two linear levels are the same to Premiere's float precision. */
function gcutSameLevel(a, b) { return Math.abs(a - b) <= 1e-4 * Math.max(Math.abs(a), Math.abs(b), 1e-6); }

/**
 * args: { sequenceId, clipIds (audio clips), db } — set each chosen clip's Volume level to db decibels
 * (clip level, as the Effect Controls' Volume > Level; at most +15). Level is linear: v = 10^((db - 15) / 20)
 * (measured: 0.17783 at 0 dB). Refuses, changing nothing: a video clip, volume keyframes, a locked track.
 * Returns { ok, db, level, changed, idMap: {}, undo: { kind: "volume", sequenceId, items: [{kind, trackIndex,
 * label, node, startT, endT, before, after}] } }.
 */
function gcutToolSetVolume(argsJson) {
    try {
        var args = gcutParse(argsJson) || {}, k;
        var seq = gcutSequence();
        gcutSameSequence(seq, args.sequenceId);
        if (!gcutIsTime(args.db) || args.db > 15) throw new Error("db must be a number of decibels, at most +15 (Premiere's clip volume limit).");
        var chosen = gcutResolveIds(seq, args.clipIds), params = [], items = [], changed = 0, v = Math.pow(10, (args.db - 15) / 20);
        for (k = 0; k < chosen.length; k++) {
            if (chosen[k].kind !== "audio") {
                throw new Error(gcutLabel(chosen[k].kind, chosen[k].trackIndex) + "'s clip is video: set_volume works on audio clips. Nothing was changed.");
            }
        }
        gcutRefuseLocked(seq, chosen, "change the volume");
        for (k = 0; k < chosen.length; k++) {
            var label = gcutLabel("audio", chosen[k].trackIndex), p = gcutLevelParam(chosen[k].item);
            if (!p) throw new Error(label + "'s clip has no Volume level Premiere shows to a script. Nothing was changed; set it by hand.");
            if (typeof p.isTimeVarying === "function" && p.isTimeVarying()) {
                throw new Error(label + "'s volume has keyframes, so one level would replace them. Nothing was changed; set it by hand.");
            }
            var x = gcutRef("audio", chosen[k].trackIndex, chosen[k].item);
            x.before = Number(p.getValue());
            params.push(p); items.push(x);
        }
        for (k = 0; k < params.length; k++) params[k].setValue(v, true);
        for (k = 0; k < params.length; k++) {
            items[k].after = Number(params[k].getValue());
            if (!(Math.abs(items[k].after - v) <= 1e-3 * v)) {
                for (var j = 0; j < params.length; j++) { try { params[j].setValue(items[j].before, true); } catch (ignored) { /* best effort */ } }
                throw new Error("Premiere didn't set " + items[k].label + "'s volume. Nothing was changed.");
            }
            if (!gcutSameLevel(items[k].before, items[k].after)) changed++;
        }
        return gcutOk({ ok: true, db: args.db, level: v, changed: changed, idMap: {}, undo: { kind: "volume", sequenceId: gcutSeqId(seq), items: items } });
    } catch (e) {
        return gcutFail(e);
    }
}

// ── mute_track ────────────────────────────────────────────────────────────────────────

/**
 * args: { sequenceId, kind: "audio" | "video", track (1-based), muted } — mute or unmute the whole track
 * (track.setMute, measured on audio). Returns { ok, track: label, muted, changed, idMap: {}, undo: { kind:
 * "mute", sequenceId, trackKind, trackIndex, label, before, after } }.
 */
function gcutToolMuteTrack(argsJson) {
    try {
        var args = gcutParse(argsJson) || {};
        var seq = gcutSequence();
        gcutSameSequence(seq, args.sequenceId);
        if (args.kind !== "audio" && args.kind !== "video") throw new Error("kind must be \"audio\" or \"video\".");
        var tracks = gcutKindTracks(seq, args.kind), n = args.track;
        if (typeof n !== "number" || Math.floor(n) !== n || n < 1 || n > tracks.numTracks) {
            throw new Error("track must be a track number from 1 to " + tracks.numTracks + " (" + gcutLabel(args.kind, 0) + " is 1).");
        }
        if (typeof args.muted !== "boolean") throw new Error("muted must be true or false.");
        var track = tracks[n - 1], label = gcutLabel(args.kind, n - 1);
        if (typeof track.setMute !== "function") throw new Error("Premiere can't mute " + label + " from a script. Nothing was changed.");
        var before = !!track.isMuted();
        track.setMute(args.muted ? 1 : 0);
        if (!!track.isMuted() !== args.muted) {
            try { track.setMute(before ? 1 : 0); } catch (ignored) { /* best effort */ }
            throw new Error("Premiere didn't " + (args.muted ? "mute " : "unmute ") + label + ". Nothing was changed.");
        }
        return gcutOk({ ok: true, track: label, muted: args.muted, changed: before !== args.muted, idMap: {},
                        undo: { kind: "mute", sequenceId: gcutSeqId(seq), trackKind: args.kind, trackIndex: n - 1, label: label, before: before, after: args.muted } });
    } catch (e) {
        return gcutFail(e);
    }
}

/** Undo a mute_track: already undone when the track reads `before`; otherwise set it back. */
function gcutUndoMute(seq, record, check) {
    if ((record.trackKind !== "audio" && record.trackKind !== "video") || typeof record.trackIndex !== "number" || typeof record.before !== "boolean") {
        throw new Error("This undo record is incomplete.");
    }
    var tracks = gcutKindTracks(seq, record.trackKind);
    if (record.trackIndex >= tracks.numTracks) throw new Error(record.label + " no longer exists. " + GCUT_BY_HAND);
    var track = tracks[record.trackIndex];
    if (!!track.isMuted() === record.before) return { ok: true, alreadyUndone: true };
    if (check) return { ok: true, wouldUndo: true };
    track.setMute(record.before ? 1 : 0);
    if (!!track.isMuted() !== record.before) throw new Error("Premiere didn't " + (record.before ? "mute " : "unmute ") + record.label + " again. Use Premiere's Undo.");
    return { ok: true };
}

// ── add_transition ────────────────────────────────────────────────────────────────────

var GCUT_VIDEO_TRANSITION = "Cross Dissolve";
var GCUT_AUDIO_TRANSITION = "Constant Power";

/**
 * args: { sequenceId, clipId, at: "start" | "end", seconds } — add a transition at the clip's start or end,
 * `seconds` long (to the frame), centred on the edit: Cross Dissolve on video, Constant Power on audio,
 * through QE's addTransition on the clip (the measured call; it counts as added only if the track's
 * transition count went up). Returns { ok, transition, at, seconds, idMap: {}, undo: { kind: "transition",
 * sequenceId, clip: {kind, trackIndex, label, node, startT, endT}, at, transition } }. Its undo, check or not,
 * leaves the transition and says so ({ ok: true, skipped: true, message }): no script call to remove one
 * transition was found (Premiere's Undo removes it), and a refusal would block the rest of a group undo.
 */
function gcutToolAddTransition(argsJson) {
    try {
        var args = gcutParse(argsJson) || {};
        var seq = gcutSequence(), clock = gcutClock(seq);
        gcutSameSequence(seq, args.sequenceId);
        if (args.at !== "start" && args.at !== "end") throw new Error("at must be \"start\" or \"end\".");
        var durT = gcutIsTime(args.seconds) ? gcutFrameT(args.seconds, clock) : 0;
        if (durT < clock.tpf) throw new Error("seconds must be the transition's length, at least one frame.");
        var c = gcutResolveIds(seq, [args.clipId])[0], ref = gcutRef(c.kind, c.trackIndex, c.item);
        gcutRefuseLocked(seq, [c], "add a transition");
        if (durT > ref.endT - ref.startT + clock.half) {
            throw new Error("A " + gcutSecText(durT / GCUT_TICKS) + " s transition is longer than " + ref.label + "'s clip (" +
                gcutSecText((ref.endT - ref.startT) / GCUT_TICKS) + " s). Nothing was changed.");
        }
        var name = c.kind === "video" ? GCUT_VIDEO_TRANSITION : GCUT_AUDIO_TRANSITION, tr = null, qt = gcutQeTrack(c.kind, c.trackIndex);
        try { tr = c.kind === "video" ? qe.project.getVideoTransitionByName(name) : qe.project.getAudioTransitionByName(name); } catch (e1) { tr = null; }
        if (!tr) throw new Error("Premiere didn't find its " + name + " transition. Nothing was changed.");
        var qi = gcutQeClipAt(qt, ref.startT, clock);
        if (!qi) throw new Error("Premiere's QE interface didn't find " + ref.label + "'s clip. Nothing was changed.");
        var before = Number(qt.numTransitions);
        qi.addTransition(tr, args.at === "start", gcutTimecode(durT, clock), "00:00:00:00", 0.5, false, true);
        var after = Number(gcutQeTrack(c.kind, c.trackIndex).numTransitions);
        if (!(isFinite(before) && isFinite(after) && after > before)) throw new Error("Premiere didn't add the transition to " + ref.label + "'s clip. Nothing was changed.");
        return gcutOk({ ok: true, transition: name, at: args.at, seconds: durT / GCUT_TICKS, idMap: {},
                        undo: { kind: "transition", sequenceId: gcutSeqId(seq), clip: ref, at: args.at, transition: name } });
    } catch (e) {
        return gcutFail(e);
    }
}

// ── set_speed ─────────────────────────────────────────────────────────────────────────

/** The QE clip for a ref ({kind, trackIndex, startT}), or null. */
function gcutQeClipFor(ref, clock) { return gcutQeClipAt(gcutQeTrack(ref.kind, ref.trackIndex), ref.startT, clock); }

/**
 * A clip's own sound or picture on the other kind of track: the same source, overlapping it, in sync (its
 * source time at any moment is the same), as { kind, trackIndex, startT, label }; or null.
 */
function gcutSyncPartner(seq, c, clock) {
    var other = c.kind === "audio" ? "video" : "audio", tracks = gcutKindTracks(seq, other), n = gcutNode(c.item);
    var s = gcutT(c.item.start), e = gcutT(c.item.end), off = c.item.inPoint.seconds - s / GCUT_TICKS;
    for (var t = 0; t < tracks.numTracks; t++) {
        var items = gcutItems(tracks[t]);
        for (var i = 0; i < items.length; i++) {
            var it = items[i], ps = gcutT(it.start);
            if (gcutNode(it) !== n || !gcutOverlaps(ps, gcutT(it.end), s, e, clock)) continue;
            if (gcutNear(it.inPoint.seconds - ps / GCUT_TICKS, off, clock.frameS)) return { kind: other, trackIndex: t, startT: ps, label: gcutLabel(other, t) };
        }
    }
    return null;
}

/**
 * args: { sequenceId, clipIds, speed } — play each chosen clip at `speed` (1 = 100%, 2 = twice as fast) with
 * QE's setSpeed(speed, "", false, false, false): measured, the clip keeps its place and timeline length (so
 * nothing else moves) and its content plays faster or slower; its linked partner is unchanged. So a clip
 * whose own sound or picture (same source, in sync, on the other kind of track) isn't chosen with it is
 * refused: they would go out of sync. Also refused, changing nothing: a reversed clip, a locked track.
 * Returns { ok, speed, changed, idMap: {} (ids don't change), undo: { kind: "speed", sequenceId, items:
 * [{kind, trackIndex, label, node, startT, endT, before, after}] } }.
 */
function gcutToolSetSpeed(argsJson) {
    try {
        var args = gcutParse(argsJson) || {}, k;
        var seq = gcutSequence(), clock = gcutClock(seq);
        gcutSameSequence(seq, args.sequenceId);
        if (!gcutIsTime(args.speed) || args.speed <= 0 || args.speed > 100) {
            throw new Error("speed must be a number above 0 and at most 100 (1 = 100%, 2 = twice as fast).");
        }
        var chosen = gcutResolveIds(seq, args.clipIds), items = [], changed = 0;
        gcutRefuseLocked(seq, chosen, "change the speed");
        for (k = 0; k < chosen.length; k++) {
            var label = gcutLabel(chosen[k].kind, chosen[k].trackIndex);
            if (gcutSpeed(chosen[k].item) < 0) throw new Error(label + "'s clip plays reversed. Nothing was changed; set its speed by hand.");
            var p = gcutSyncPartner(seq, chosen[k], clock);
            if (p && !gcutRecordedAt(gcutChosenFound(chosen), p.kind, p.trackIndex, p.startT)) {
                throw new Error(label + "'s clip and its own " + (p.kind === "audio" ? "sound" : "picture") + " on " + p.label +
                    " would go out of sync. Choose both, or neither. Nothing was changed.");
            }
            var x = gcutRef(chosen[k].kind, chosen[k].trackIndex, chosen[k].item);
            x.before = gcutSpeed(chosen[k].item); x.after = args.speed;
            if (Math.abs(x.before - x.after) > 1e-6) changed++;
            items.push(x);
        }
        var qis = [];
        for (k = 0; k < items.length; k++) {
            qis.push(gcutQeClipFor(items[k], clock));
            if (!qis[k]) throw new Error("Premiere's QE interface didn't find " + items[k].label + "'s clip. Nothing was changed.");
        }
        for (k = 0; k < items.length; k++) {
            qis[k].setSpeed(args.speed, "", false, false, false);
            var now = gcutFindRef(seq, items[k]);
            if (!now || Math.abs(gcutSpeed(now) - args.speed) > 1e-4) {
                for (var j = k; j >= 0; j--) { try { qis[j].setSpeed(items[j].before, "", false, false, false); } catch (ignored) { /* best effort */ } }
                throw new Error("Premiere didn't set " + items[k].label + "'s speed. Nothing was changed.");
            }
        }
        return gcutOk({ ok: true, speed: args.speed, changed: changed, idMap: {}, undo: { kind: "speed", sequenceId: gcutSeqId(seq), items: items } });
    } catch (e) {
        return gcutFail(e);
    }
}

// ── motion graphics: place_graphic, replace_graphic ───────────────────────────────────

/*
 * A graphic is a transparent MOV without sound that the backend's make_graphic rendered next to the project
 * (<project folder>/Genius Cut Graphics/<slug>/v<N>/<slug>.mov). It is imported once into a "Genius Cut
 * Graphics" bin (app.project.importFiles(paths, true, bin, false), measured 2026-10-21 with a ProRes MOV) and
 * laid whole with overwriteClip at a whole frame (the spike laid a 4 s MOV on V2 so, and a MOV without sound
 * lays no sound). Never TrackItem.move. Every version of a graphic has the same file name, so the imported
 * item is found by its media path, not its name. A placed graphic's id is the usual clip id (gcutClipId).
 */
var GCUT_GRAPHICS_BIN = "Genius Cut Graphics";
var GCUT_BIN_TYPE = 2; // ProjectItemType.BIN

/**
 * What a graphics render needs: { projectPath (app.project.path, "" for a project never saved), width,
 * height (the active sequence's frame size), timebase (ticks per frame, as a string) }.
 */
function gcutGraphicsContext() {
    try {
        var seq = gcutSequence();
        return gcutOk({ projectPath: String(app.project.path || ""), width: Number(seq.frameSizeHorizontal),
                        height: Number(seq.frameSizeVertical), timebase: String(seq.timebase) });
    } catch (e) {
        return gcutFail(e);
    }
}

/** A file path compared as Windows does: either slash, any case. */
function gcutPathKey(p) { return String(p).replace(/\\/g, "/").toLowerCase(); }

function gcutChildren(item) {
    var out = [];
    if (item && item.children) for (var k = 0; k < item.children.numItems; k++) out.push(item.children[k]);
    return out;
}

/** The project's top-level "Genius Cut Graphics" bin, made the first time. */
function gcutGraphicsBin() {
    for (var pass = 0; pass < 2; pass++) {
        var root = app.project.rootItem, kids = gcutChildren(root);
        for (var k = 0; k < kids.length; k++) if (kids[k].type === GCUT_BIN_TYPE && String(kids[k].name) === GCUT_GRAPHICS_BIN) return kids[k];
        if (pass === 0) root.createBin(GCUT_GRAPHICS_BIN);
    }
    throw new Error("Premiere didn't make the \"" + GCUT_GRAPHICS_BIN + "\" bin.");
}

/** The item in this bin imported from `path`, or null. */
function gcutMediaIn(bin, path) {
    var kids = gcutChildren(bin), key = gcutPathKey(path);
    for (var k = 0; k < kids.length; k++) {
        if (kids[k].type === GCUT_BIN_TYPE) continue;
        var p;
        try { p = kids[k].getMediaPath(); } catch (e) { continue; }
        if (gcutPathKey(p) === key) return kids[k];
    }
    return null;
}

/** The graphic file's project item: the one already in the graphics bin, or imported there now. */
function gcutImportGraphic(path) {
    var bin = gcutGraphicsBin(), pi = gcutMediaIn(bin, path);
    if (pi) return pi;
    try { app.project.importFiles([String(path)], true, bin, false); } catch (e) { /* checked below */ }
    pi = gcutMediaIn(bin, path);
    if (!pi) throw new Error("Premiere didn't import " + path + ". Check that the file is there.");
    return pi;
}

/**
 * The whole file's span, { inS, lenS }: the item's marks cleared, read, and set back as they were (a graphic
 * is always laid whole, whatever marks the bin item holds).
 */
function gcutWholeMedia(pi, clock) {
    var tolS = clock.frameS / 2, inS = pi.getInPoint().seconds, outS = pi.getOutPoint().seconds;
    if (typeof pi.clearInPoint !== "function" || typeof pi.clearOutPoint !== "function") return { inS: inS, lenS: outS - inS };
    pi.clearOutPoint();
    pi.clearInPoint();
    var whole = { inS: pi.getInPoint().seconds, lenS: pi.getOutPoint().seconds - pi.getInPoint().seconds };
    if (!gcutNear(whole.inS, inS, tolS) || !gcutNear(whole.inS + whole.lenS, outS, tolS)) gcutSetRange(pi, inS, outS, tolS);
    return whole;
}

/** The first clip on video track t overlapping [fromT, toT) (by more than half a frame) other than one starting at `exceptT`, or null. */
function gcutGraphicBlocker(seq, t, fromT, toT, clock, exceptT) {
    var items = gcutItems(seq.videoTracks[t]);
    for (var i = 0; i < items.length; i++) {
        var s = gcutT(items[i].start);
        if (s !== exceptT && gcutOverlaps(s, gcutT(items[i].end), fromT, toT, clock)) return items[i];
    }
    return null;
}

/** The graphic of `node` on video track t exactly as laid: start atT, length durT, in point inS; or null. */
function gcutGraphicAt(seq, t, node, atT, inS, durT, clock) {
    var items = gcutItems(seq.videoTracks[t]);
    for (var i = 0; i < items.length; i++) {
        var it = items[i], s = gcutT(it.start);
        if (gcutNode(it) === node && gcutNear(s, atT, clock.half) && gcutNear(gcutT(it.end) - s, durT, clock.half) &&
            gcutNear(it.inPoint.seconds, inS, clock.frameS / 2)) return it;
    }
    return null;
}

/** Take off every clip of `node` overlapping [fromT, toT) on any track, except those in `others` (there before). */
function gcutTakeOffGraphic(seq, node, fromT, toT, clock, others) {
    var tracks = gcutTracks(seq);
    for (var t = 0; t < tracks.length; t++) {
        var items = gcutItems(tracks[t].track);
        for (var i = items.length - 1; i >= 0; i--) {
            var s = gcutT(items[i].start);
            if (gcutNode(items[i]) !== node || !gcutOverlaps(s, gcutT(items[i].end), fromT, toT, clock) || gcutKept(others, t, s, node)) continue;
            try { items[i].remove(false, false); } catch (ignored) { /* checked by the caller */ }
        }
    }
}

/** True if nothing of `node` but `others` overlaps [fromT, toT) and every one of `others` is as it was. */
function gcutGraphicClean(seq, node, fromT, toT, clock, others) {
    var tracks = gcutTracks(seq);
    for (var t = 0; t < tracks.length; t++) {
        var items = gcutItems(tracks[t].track);
        for (var i = 0; i < items.length; i++) {
            var s = gcutT(items[i].start);
            if (gcutNode(items[i]) === node && gcutOverlaps(s, gcutT(items[i].end), fromT, toT, clock) && !gcutKept(others, t, s, node)) return false;
        }
    }
    return !gcutSnapshotIntact(seq, others, clock);
}

/**
 * Lay `pi` from inS for durT ticks at atT on video track t (overwriteClip; the bin item's own marks set back
 * after) and check it: exactly there, and nothing in `others` (what overlapped the span on every track
 * before) changed. Returns the laid clip; otherwise takes off what it laid and returns null.
 */
function gcutLayGraphic(seq, t, pi, atT, inS, durT, clock, others) {
    var tolS = clock.frameS / 2, outS = inS + durT / GCUT_TICKS, it = null;
    var marks = { inS: pi.getInPoint().seconds, outS: pi.getOutPoint().seconds };
    var reset = !gcutNear(marks.inS, inS, tolS) || !gcutNear(marks.outS, outS, tolS);
    try {
        if (reset) gcutSetRange(pi, inS, outS, tolS);
        seq.videoTracks[t].overwriteClip(pi, String(atT));
        it = gcutGraphicAt(seq, t, pi.nodeId, atT, inS, durT, clock);
        if (it && gcutSnapshotIntact(seq, others, clock)) it = null;
    } catch (e) {
        it = null;
    } finally {
        if (reset) { try { gcutSetRange(pi, marks.inS, marks.outS, tolS); } catch (ignored) { /* best effort */ } }
    }
    if (!it) gcutTakeOffGraphic(seq, pi.nodeId, atT, atT + durT, clock, others);
    return it;
}

/** A placed graphic as its undo record names it: gcutRef plus its in point and on/off. */
function gcutGraphicRef(t, it, clock) {
    var ref = gcutRef("video", t, it);
    ref.inS = gcutClipInS("video", it, clock);
    ref.enabled = gcutEnabled(it);
    return ref;
}

function gcutGraphicByHand(ref) { return new Error("The graphic on " + ref.label + " was moved, trimmed or replaced by hand since. " + GCUT_BY_HAND); }

function gcutIsGraphicRef(ref) {
    return ref && typeof ref.trackIndex === "number" && typeof ref.startT === "number" && typeof ref.endT === "number" &&
        typeof ref.inS === "number" && typeof ref.node === "string" && typeof ref.label === "string";
}

/**
 * args: { sequenceId, path (make_graphic's MOV), atS, aboveTrack? (1-based video track: the selection's highest;
 * default 1) } — import the graphic into the "Genius Cut Graphics" bin (reused, as is a file already imported)
 * and lay it whole at atS (to the nearest frame) on the lowest video track above aboveTrack that is unlocked and
 * empty over the WHOLE span [atS, atS + its length]. A new track can't be made from a script: when none is free
 * it refuses ("Add a video track"), changing nothing on the timeline. Returns { ok, track ("V3"), startS, endS,
 * newIds: [the laid clip's id], idMap: {}, undo: { kind: "graphic-place", sequenceId, clip: {kind, trackIndex,
 * label, node, startT, endT, inS, enabled}, path } }.
 */
function gcutToolPlaceGraphic(argsJson) {
    try {
        var args = gcutParse(argsJson) || {};
        var seq = gcutSequence(), clock = gcutClock(seq), nV = seq.videoTracks.numTracks;
        gcutSameSequence(seq, args.sequenceId);
        if (typeof args.path !== "string" || !args.path) throw new Error("path must be the rendered graphic's file (make_graphic's path).");
        var endS = gcutSeqEndT(seq) / GCUT_TICKS;
        if (!gcutIsTime(args.atS) || args.atS < 0 || args.atS > endS) throw new Error("atS must be a time between 0 and " + gcutSecText(endS) + " s (the sequence's end).");
        var above = args.aboveTrack === undefined || args.aboveTrack === null ? 1 : args.aboveTrack;
        if (typeof above !== "number" || Math.floor(above) !== above || above < 1 || above > nV) {
            throw new Error("aboveTrack must be a video track number from 1 to " + nV + ".");
        }
        var pi = gcutImportGraphic(args.path), whole = gcutWholeMedia(pi, clock);
        var atT = gcutFrameT(args.atS, clock), durT = gcutFrameT(whole.lenS, clock), toT = atT + durT, t = -1, k;
        if (durT <= 0) throw new Error(args.path + " is shorter than a frame.");
        for (k = above; k < nV && t < 0; k++) {
            var track = seq.videoTracks[k];
            if (typeof track.isLocked === "function" && track.isLocked()) continue;
            if (!gcutGraphicBlocker(seq, k, atT, toT, clock, null)) t = k;
        }
        if (t < 0) {
            throw new Error("No video track above V" + above + " is free from " + gcutSecText(atT / GCUT_TICKS) + " s to " + gcutSecText(toT / GCUT_TICKS) +
                " s. Add a video track in Premiere (or make room), then try again.");
        }
        var others = gcutOthers(seq, [], atT, toT), label = gcutLabel("video", t);
        var it = gcutLayGraphic(seq, t, pi, atT, whole.inS, durT, clock, others);
        if (!it) {
            throw new Error(gcutGraphicClean(seq, pi.nodeId, atT, toT, clock, others)
                ? "The graphic didn't land on " + label + " as expected, so it was taken off again. Nothing was changed on the timeline."
                : "The graphic didn't land on " + label + " as expected, and what was laid couldn't all be taken off. Use Premiere's Undo.");
        }
        return gcutOk({ ok: true, track: label, startS: atT / GCUT_TICKS, endS: toT / GCUT_TICKS, newIds: [gcutClipId("video", t, it)], idMap: {},
                        undo: { kind: "graphic-place", sequenceId: gcutSeqId(seq), clip: gcutGraphicRef(t, it, clock), path: args.path } });
    } catch (e) {
        return gcutFail(e);
    }
}

/**
 * Undo a place_graphic: take exactly that clip off (the file stays in the bin). Gone, with nothing where it
 * was: already undone. Anything else there (it was moved, trimmed or replaced): refused, changing nothing.
 */
function gcutUndoGraphicPlace(seq, record, clock, check) {
    var ref = record.clip;
    if (!gcutIsGraphicRef(ref)) throw new Error("This undo record is incomplete.");
    var it = gcutFindRef(seq, ref);
    if (!it) {
        if (ref.trackIndex >= seq.videoTracks.numTracks || gcutGraphicBlocker(seq, ref.trackIndex, ref.startT, ref.endT, clock, null)) throw gcutGraphicByHand(ref);
        return { ok: true, alreadyUndone: true };
    }
    gcutRefuseLocked(seq, [ref], "undo");
    if (check) return { ok: true, wouldUndo: true };
    it.remove(false, false);
    if (gcutFindRef(seq, ref)) throw new Error("Premiere didn't take the graphic off " + ref.label + ". Use Premiere's Undo.");
    return { ok: true };
}

/**
 * args: { sequenceId, clipId (a placed graphic, from get_sequence), path (the new version's MOV) } — take the
 * graphic off and lay the new version at the SAME start, with ITS OWN length (a slower version is longer), on
 * the same track, on or off as the old one was. Refuses, changing nothing on the timeline, when anything else
 * is on that track over the new version's span, the track is locked, the clip isn't on a video track or isn't
 * at 100% speed, or the path is the version already there. Returns { ok, track, startS, endS, warning?,
 * idMap: { oldId: [newId] }, undo: { kind: "graphic-replace", sequenceId, from, to (as place_graphic's clip),
 * fromPath, toPath } }.
 */
function gcutToolReplaceGraphic(argsJson) {
    try {
        var args = gcutParse(argsJson) || {};
        var seq = gcutSequence(), clock = gcutClock(seq);
        gcutSameSequence(seq, args.sequenceId);
        if (typeof args.path !== "string" || !args.path) throw new Error("path must be the new version's file (make_graphic's path).");
        var chosen = gcutResolveIds(seq, [args.clipId]);
        if (chosen.length !== 1 || chosen[0].kind !== "video") throw new Error("Choose the graphic's clip on its video track.");
        var t = chosen[0].trackIndex, old = chosen[0].item, label = gcutLabel("video", t);
        gcutRefuseLocked(seq, chosen, "replace a graphic");
        if (!old.projectItem) throw new Error(label + "'s clip has no source file, so it isn't a graphic Genius Cut placed.");
        if (Math.abs(gcutSpeed(old) - 1) > 1e-6) throw new Error(label + "'s graphic isn't at 100% speed, so replacing it couldn't be undone exactly. Set it back to 100% first.");
        var fromPath = gcutSource(old);
        if (gcutPathKey(fromPath) === gcutPathKey(args.path)) throw new Error("That version is the one already placed.");
        var from = gcutGraphicRef(t, old, clock), oldId = gcutClipId("video", t, old), oldPi = old.projectItem;
        var pi = gcutImportGraphic(args.path), whole = gcutWholeMedia(pi, clock);
        var atT = from.startT, durT = gcutFrameT(whole.lenS, clock), toT = atT + durT;
        if (durT <= 0) throw new Error(args.path + " is shorter than a frame.");
        if (gcutGraphicBlocker(seq, t, atT, toT, clock, atT)) {
            throw new Error("Something is on " + label + " between " + gcutSecText(atT / GCUT_TICKS) + " s and " + gcutSecText(toT / GCUT_TICKS) +
                " s, where the new version would run. Make room there, then try again. Nothing was changed.");
        }
        var fx = gcutClipEffects("video", old);
        var others = gcutOthers(seq, [{ kind: "video", trackIndex: t, startT: atT }], atT, Math.max(toT, from.endT));
        old.remove(false, false);
        if (gcutFindRef(seq, from)) throw new Error("The old version didn't come off " + label + ". Use Premiere's Undo to put back anything that did.");
        var it = gcutLayGraphic(seq, t, pi, atT, whole.inS, durT, clock, others);
        if (!it) {
            var back = gcutGraphicClean(seq, pi.nodeId, atT, toT, clock, others) ? gcutLayGraphic(seq, t, oldPi, atT, from.inS, from.endT - from.startT, clock, others) : null;
            if (back && !from.enabled) back.disabled = true;
            throw new Error(back
                ? "The new version didn't land on " + label + " as expected, so the old one was laid back. Nothing was changed."
                : "The new version didn't land on " + label + " as expected, and the old one couldn't be laid back. Use Premiere's Undo.");
        }
        if (!from.enabled) it.disabled = true;
        return gcutOk({ ok: true, track: label, startS: atT / GCUT_TICKS, endS: toT / GCUT_TICKS,
                        warning: fx.length ? "The old version's effects (" + fx.join(", ") + ") weren't carried over to the new one." : undefined,
                        idMap: gcutMapOf(oldId, gcutClipId("video", t, it)),
                        undo: { kind: "graphic-replace", sequenceId: gcutSeqId(seq), from: from, to: gcutGraphicRef(t, it, clock), fromPath: fromPath, toPath: args.path } });
    } catch (e) {
        return gcutFail(e);
    }
}

function gcutMapOf(oldId, newId) { var m = {}; m[oldId] = [newId]; return m; }

/**
 * Undo a replace_graphic: take the new version off and lay the old one back at its old start and length, on
 * or off as it was. The old one back and the new gone: already undone. The new one not exactly as laid, or
 * anything else where the old one would go: refused, changing nothing. A lay that fails lays the new one back.
 */
function gcutUndoGraphicReplace(seq, record, clock, check) {
    var from = record.from, to = record.to;
    if (!gcutIsGraphicRef(from) || !gcutIsGraphicRef(to)) throw new Error("This undo record is incomplete.");
    var now = gcutFindRef(seq, to);
    if (!now) {
        if (gcutFindRef(seq, from)) return { ok: true, alreadyUndone: true };
        throw gcutGraphicByHand(to);
    }
    if (gcutGraphicBlocker(seq, from.trackIndex, from.startT, from.endT, clock, to.startT)) {
        throw new Error("Something was placed on " + from.label + " where the old version would go back since. " + GCUT_BY_HAND);
    }
    var oldPi = gcutProjectItemByNode(from.node);
    if (!oldPi) throw new Error(from.label + "'s old version isn't in the project any more, so the replace can't be undone. Use Premiere's Undo instead.");
    gcutRefuseLocked(seq, [to], "undo");
    if (check) return { ok: true, wouldUndo: true };
    var newPi = now.projectItem, toT = Math.max(from.endT, to.endT);
    var others = gcutOthers(seq, [{ kind: "video", trackIndex: to.trackIndex, startT: to.startT }], from.startT, toT);
    now.remove(false, false);
    if (gcutFindRef(seq, to)) throw new Error("Premiere didn't take the new version off " + to.label + ". Use Premiere's Undo.");
    var it = gcutLayGraphic(seq, from.trackIndex, oldPi, from.startT, from.inS, from.endT - from.startT, clock, others);
    if (!it) {
        var back = gcutGraphicClean(seq, from.node, from.startT, from.endT, clock, others)
            ? gcutLayGraphic(seq, to.trackIndex, newPi, to.startT, to.inS, to.endT - to.startT, clock, others) : null;
        if (back && !to.enabled) back.disabled = true;
        throw new Error(back
            ? "The old version didn't go back on " + from.label + " as expected, so the new one was laid back. Nothing was undone; try again, or use Premiere's Undo."
            : "The old version didn't go back on " + from.label + " as expected, and the new one couldn't be laid back. Use Premiere's Undo.");
    }
    if (!from.enabled) it.disabled = true;
    return { ok: true };
}

/** Chosen clips ({kind, trackIndex, item}) as gcutRecordedAt reads them. */
function gcutChosenFound(chosen) {
    var out = [];
    for (var k = 0; k < chosen.length; k++) out.push({ kind: chosen[k].kind, trackIndex: chosen[k].trackIndex, startT: gcutT(chosen[k].item.start) });
    return out;
}

/**
 * args: { record, check? } — the `undo` record an act tool returned, as it returned it (pure data, so it
 * survives a panel reload). Returns { ok: true }, or { ok: true, alreadyUndone: true } when nothing of
 * that change is left (Premiere's own Undo took it back), or { ok: true, skipped: true, message } for a change
 * Genius Cut can't take back (a transition), which stays; refuses, changing nothing, when what that
 * change made was changed by hand since. check: true runs the same refusals and changes nothing,
 * returning { ok: true, wouldUndo: true } or { ok: true, alreadyUndone: true }, or the same refusal.
 */
function gcutToolUndo(argsJson) {
    try {
        var args = gcutParse(argsJson) || {}, record = args.record;
        if (!record || !record.kind) throw new Error("There's nothing to undo.");
        var seq = gcutSequence(), clock = gcutClock(seq);
        if (String(record.sequenceId) !== gcutSeqId(seq)) {
            throw new Error("A different sequence is open than the one this change was made on. Open that sequence first.");
        }
        var check = args.check === true;
        if (record.kind === "markers") return gcutOk(gcutUndoMarkers(seq, record, clock, check));
        if (record.kind === "cuts") return gcutOk(gcutUndoCuts(seq, record, clock, check));
        if (record.kind === "delete") return gcutOk(gcutUndoDelete(seq, record, clock, check));
        if (record.kind === "moves") return gcutOk(gcutUndoMoves(seq, record, clock, check));
        if (record.kind === "split" || record.kind === "angle") return gcutOk(gcutUndoSplits(seq, record, clock, check));
        if (record.kind === "enabled") {
            return gcutOk(gcutUndoSettings(seq, record, check, "on/off", gcutEnabled,
                function (it, v) { it.disabled = !v; }, function (a, b) { return a === b; }));
        }
        if (record.kind === "volume") {
            return gcutOk(gcutUndoSettings(seq, record, check, "volume", gcutLevel,
                function (it, v) { gcutLevelParam(it).setValue(v, true); }, gcutSameLevel));
        }
        if (record.kind === "speed") {
            return gcutOk(gcutUndoSettings(seq, record, check, "speed", gcutSpeed, function (it, v, x) {
                var qi = gcutQeClipFor(x, clock);
                if (!qi) throw new Error("Premiere's QE interface didn't find " + x.label + "'s clip. Use Premiere's Undo.");
                qi.setSpeed(v, "", false, false, false);
            }, function (a, b) { return Math.abs(a - b) <= 1e-4; }));
        }
        if (record.kind === "mute") return gcutOk(gcutUndoMute(seq, record, check));
        if (record.kind === "graphic-place") return gcutOk(gcutUndoGraphicPlace(seq, record, clock, check));
        if (record.kind === "graphic-replace") return gcutOk(gcutUndoGraphicReplace(seq, record, clock, check));
        if (record.kind === "transition") {
            // No measured script call removes one transition; refusing would block a whole group undo.
            return gcutOk({ ok: true, skipped: true, message: "The transition stays: Premiere can't remove it from a script. Remove it by hand if needed." });
        }
        throw new Error("Genius Cut can't undo a change of kind " + record.kind + ".");
    } catch (e) {
        return gcutFail(e);
    }
}

function gcutHostVersion() {
    return "0.1.0";
}
