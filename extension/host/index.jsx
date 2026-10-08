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
 * pieces re-laid from its own source with overwriteClip, on its own track (no razor: Premiere
 * 2026 silently no-ops the QE razor). Consequences:
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
 * Apply or Restore. Exact when the clip's own frames are longer than the sequence's (only one of
 * them fits there); otherwise the last one that fits, which maps back to itself every time.
 */
function gcutTrueInS(reportedS, ownFrameS, seqFrameS) {
    var own = Math.floor((reportedS + seqFrameS) / ownFrameS - 1e-6) * ownFrameS;
    return own >= reportedS - 1e-9 ? own : reportedS;
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
 * points down to them), or the sequence's for audio. A loose item's (see gcutRefind) is used as it
 * is: snapped, it could sit up to half a frame late, and a piece running to the very end of its
 * source would then need media past the end to reach its planned length.
 */
function gcutItemPieces(item, cutsT, srcFrameS) {
    var out = [], cursor = item.startT;
    function push(fromT, toT) {
        if (toT <= fromT) return;
        var srcIn = item.inS + (fromT - item.startT) / GCUT_TICKS;
        if (!item.loose) srcIn = Math.round(srcIn / srcFrameS) * srcFrameS;
        out.push({ fromT: fromT, durT: toT - fromT, atT: fromT - gcutRemovedBefore(cutsT, fromT), srcIn: srcIn });
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

/** True if `a` (audio from a video file) is video item `v`'s own sound: the same file, starting with it, in sync. */
function gcutOwnSound(a, v, clock) {
    return a.node === v.node && gcutNear(a.startT, v.startT, clock.half) &&
        gcutNear(a.inS - a.startT / GCUT_TICKS, v.inS - v.startT / GCUT_TICKS, clock.frameS / 2 + gcutSlackS(a));
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
                throw new Error(x.label + "'s audio comes from the same file as " + there + "'s video but doesn't start with it in sync, so Genius Cut " +
                    "can't place both on these tracks. Line them up, or put the audio on a track number with no selected video.");
            }
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
        // srcIn is already on the source frame grid (Premiere rounds set points down to it); a
        // quarter frame later is the fallback when floating-point error rounds it a frame low.
        var srcIn = pieces[p].srcIn, endT = pieces[p].atT + pieces[p].durT, nudge = f.srcFrameS / 4;
        var spill = f.loose && endT + overT + f.mediaFrameS * GCUT_TICKS <= lastEndT;
        var srcOut = srcIn + (pieces[p].durT + (spill ? overT : 0)) / GCUT_TICKS;
        try { gcutSetRange(f.pi, srcIn, srcOut, tolS); }
        catch (rangeErr) { gcutSetRange(f.pi, srcIn + nudge, srcOut + nudge, tolS); }
        if (f.loose && !spill) {
            var shortOut = f.pi.getInPoint().seconds + pieces[p].durT / GCUT_TICKS;
            if (f.pi.getOutPoint().seconds > shortOut && !gcutSetOne(f.pi, "out", shortOut, tolS)) {
                throw new Error("Premiere didn't accept the source out point " + shortOut.toFixed(3) + " s.");
            }
        }
        track.overwriteClip(f.pi, String(pieces[p].atT));
        if (f.loose) gcutTrimTo(track, f, pieces[p].atT, endT, clock);
        if (sound && sound.ends[p] !== null) gcutTrimTo(soundTrack, sound.f, pieces[p].atT, sound.ends[p], clock);
    }
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
 * True if a laid piece's in point, as Premiere reports it (gotS), fits the planned srcIn. Premiere
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
 *             piece's sound end (the audio piece starting with it), or null where none does }; else null;
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
            var ends = [], rest = [];
            for (q = 0; q < plan[i].length; q++) ends.push(null);
            for (p = 0; p < plan[j].length; p++) {
                var made = false;
                for (q = 0; q < plan[i].length; q++) {
                    if (gcutNear(plan[i][q].atT, plan[j][p].atT, clock.half)) { ends[q] = plan[j][p].atT + plan[j][p].durT; made = true; }
                }
                if (!made) rest.push(plan[j][p]);
            }
            sound[i] = { f: a, ends: ends };
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
    var nodes = [], whole = [], i, span = gcutSpan(rec.items);
    for (i = 0; i < rec.items.length; i++) { nodes.push(rec.items[i].node); whole.push(gcutWhole(rec.items[i])); }
    gcutRemoveRange(seq, nodes, span.fromT, span.toT, clock, others);
    gcutLayAll(seq, rec.items, whole, span.fromT, span.toT, clock, others);
    for (i = 0; i < rec.items.length; i++) if (gcutVerifyItems(seq, rec.items[i], whole[i], clock)) return false;
    return !gcutStrayLeft(seq, rec.items, whole, span.fromT, span.toT, clock, others);
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
    var seq, clock, marks = [], k;
    try {
        var spec = gcutParse(specJson);
        seq = gcutSequence(); clock = gcutClock(seq);
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
        var span = gcutSpan(found), plan = gcutPlan(found, cutsT), removedT = gcutRemovedBefore(cutsT, endT), rebuiltEndT = span.fromT;
        for (k = 0; k < found.length; k++) rebuiltEndT = Math.max(rebuiltEndT, gcutNewEnd(found[k], cutsT));
        var others = gcutOthers(seq, found, span.fromT, span.toT);
        for (k = 0; k < found.length; k++) {
            var seen = false;
            for (var m = 0; m < marks.length; m++) if (marks[m].node === found[k].node) seen = true;
            if (!seen) marks.push({ pi: found[k].pi, node: found[k].node, inS: found[k].pi.getInPoint().seconds, outS: found[k].pi.getOutPoint().seconds });
        }
        var key = "m@" + spec.startTicks;
        var rec = { sequenceId: gcutSeqId(seq), startT: startT, endT: endT, cutsT: cutsT, rebuiltEndT: rebuiltEndT,
                    gapClosed: false, items: found, others: others };
        // A new Apply at the same start replaces the earlier record (that Restore is meaningless once
        // the timeline changed again); if this one rolls back cleanly, the earlier record comes back.
        var stash = gcutState().gcutStash, hadPrev = stash.hasOwnProperty(key), prev = stash[key];
        stash[key] = rec; // written before anything changes, so it can always be rolled back
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
            var keptS = (endT - startT - removedT) / GCUT_TICKS; // the range, once the cuts are out
            return gcutOk({ ok: true, appliedCount: cutsT.length, clipCount: found.length,
                expectedDuration: keptS, actualDuration: keptS, trailingGapS: removedT / GCUT_TICKS });
        } catch (inner) {
            var back = false;
            try { back = gcutRelayAll(seq, rec, clock, others); } catch (ignored) { back = false; }
            if (back) { if (hadPrev) stash[key] = prev; else delete stash[key]; }
            var damage = gcutSnapshotIntact(seq, others, clock);
            return gcutOk({ ok: false, rolledBack: back, appliedCount: 0, clipCount: 0, expectedDuration: 0,
                actualDuration: 0, trailingGapS: 0,
                message: inner.message + (back ? " Every clip was put back." : " They couldn't be put back automatically: use Premiere's Undo.") +
                    (damage ? " Something on " + damage + " was changed too: use Undo to recover it." : "") });
        }
    } catch (e) {
        return gcutFail(e);
    } finally {
        // Always leave the bin items' own in/out marks as they were.
        for (k = 0; k < marks.length; k++) {
            try { gcutSetRange(marks[k].pi, marks[k].inS, marks[k].outS, clock.frameS / 2); } catch (ignored2) { /* best effort */ }
        }
    }
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
        // If Restore fails, the record is kept as it was, so Close gap still sees the gap.
        if (!gcutRelayAll(seq, rec, clock, others)) throw new Error("The original clips didn't go back as expected. Use Premiere's Undo.");
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

function gcutHostVersion() {
    return "0.1.0";
}
