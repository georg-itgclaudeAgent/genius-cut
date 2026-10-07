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
 * video clips and the selected audio) following plan decision D2: remove each clip and re-lay
 * the same kept spans from its own source with overwriteClip, on its own track (no razor:
 * Premiere 2026 silently no-ops the QE razor). Consequences:
 *   - The rebuild lays fresh clips from the source, so effects, grades, keyframes and audio
 *     gain on the originals are NOT carried over. gcutSnapshotSelection names the effects on
 *     each clip so the panel can warn before Apply.
 *   - Apply is all-or-nothing: every piece is checked as it lands, and any failure rolls every
 *     clip back. The bin items' own in/out marks are always restored.
 *   - Clips it can't rebuild safely are refused before anything changes: retimed clips, clips
 *     that don't start and end together, and audio running past them (J/L cuts, music beds).
 *   - Restore puts every recorded clip back; Close gap pulls everything after the edit left, on
 *     every track. Both work from the record Apply keeps for this session only.
 *
 * Unverified against real Premiere until Checkpoint B (docs silent or contradictory):
 *   - setInPoint/setOutPoint units (docs say ticks for one, seconds for the other): set,
 *     read back, fall back to the other unit, and remember which worked;
 *   - whether videoTrack.overwriteClip brings the clip's linked audio, and onto which audio
 *     track: checked afterwards and removed, never assumed;
 *   - whether audioTrack.overwriteClip places audio only, for a project item that also has video;
 *   - whether remove() also acts on linked partners, and whether move() moves the linked
 *     partner: handled either way (Close gap moves each item and checks every track after).
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
    for (t = 0; t < seq.videoTracks.numTracks; t++) all.push({ track: seq.videoTracks[t], label: "V" + (t + 1), audio: false, index: t });
    for (t = 0; t < seq.audioTracks.numTracks; t++) all.push({ track: seq.audioTracks[t], label: "A" + (t + 1), audio: true, index: t });
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

/** The source media's frame rate, falling back to the sequence's if Premiere won't say. */
function gcutSourceFps(pi, clock) {
    try {
        var fps = Number(pi.getFootageInterpretation().frameRate);
        if (fps > 0 && isFinite(fps)) return fps;
    } catch (e) { /* not available on this item */ }
    return clock.fps;
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
    throw new Error("Premiere didn't accept the source range " + inS.toFixed(3) + "-" + outS.toFixed(3) + " s.");
}

// ── multi-clip: synced angles of one recording, cut together ────────────────────────

function gcutKindTracks(seq, kind) { return kind === "audio" ? seq.audioTracks : seq.videoTracks; }
function gcutLabel(kind, index) { return (kind === "audio" ? "A" : "V") + (index + 1); }
function gcutSeqId(seq) { return String(seq.sequenceID || seq.name || ""); }

/** Every item is cut as if it spans the whole range, so one that covers only part of it is refused. */
function gcutPartialMessage(label) {
    return label + " doesn't start and end with the video clips. Genius Cut needs every clip it cuts, " +
        "audio too, to cover the same stretch of the timeline.";
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
                for (var k = 0; k < video.length; k++) {
                    var vi = video[k].item;
                    if (gcutNode(it) === gcutNode(vi) && e > gcutT(vi.start) + clock.half && s < gcutT(vi.end) - clock.half) {
                        problems.push(gcutLabel("audio", t) + " is linked to " + gcutLabel("video", video[k].track) +
                            " but isn't selected. Select it too, or unlink it.");
                        break;
                    }
                }
            }
        }
        var startT = vStart, endT = vEnd; // R; falls back to the video span when there is none
        if (!out.audio.length) {
            problems.push("No audio clip is selected. Select the audio Genius Cut should transcribe along with the video clips.");
        } else if (Math.min(vEnd, aEnd) <= Math.max(vStart, aStart)) {
            problems.push("The selected audio doesn't overlap the selected video clips, so there's nothing to transcribe.");
        } else {
            startT = Math.max(vStart, aStart); endT = Math.min(vEnd, aEnd);
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

// ── gcutApplyCutsMulti: the same cuts on every recorded clip, all or nothing ────────

/** Re-find each recorded item by kind, track and exact start; refuse if any moved or changed. */
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
        if (!gcutNear(gcutT(it.start), Number(spec.startTicks), clock.half) || !gcutNear(gcutT(it.end), Number(spec.endTicks), clock.half)) {
            throw new Error(gcutPartialMessage(label));
        }
        if (typeof track.isLocked === "function" && track.isLocked()) throw new Error(label + " is locked. Unlock it to apply.");
        if (Math.abs(gcutSpeed(it) - 1) > 1e-6) throw new Error(label + " isn't at 100% speed. Nothing was changed.");
        var srcFps = gcutSourceFps(it.projectItem, clock), ratio = srcFps / clock.fps;
        if (Math.round(ratio) < 1 || Math.abs(ratio - Math.round(ratio)) > 1e-3) {
            throw new Error(label + " is " + Math.round(srcFps * 1000) / 1000 + " fps but the sequence is " +
                Math.round(clock.fps * 1000) / 1000 + " fps. Genius Cut can only rebuild clips whose frame rate matches " +
                "the sequence (or is a whole multiple of it) for now. Nothing was changed.");
        }
        found.push({ kind: x.kind, trackIndex: x.trackIndex, label: label, item: it, pi: it.projectItem,
                     node: it.projectItem.nodeId, startT: gcutT(it.start), inS: it.inPoint.seconds,
                     outS: it.outPoint.seconds, srcFrameS: 1 / srcFps });
    }
    return found;
}

/**
 * Refuse if any audio under [startT, endT), on any audio track, wasn't recorded at Analyse: an
 * angle's linked audio may land on that track and overwrite it, and that's only seen afterwards.
 */
function gcutAudioAdded(seq, spec, startT, endT, clock) {
    for (var t = 0; t < seq.audioTracks.numTracks; t++) {
        var items = gcutItems(seq.audioTracks[t]);
        for (var i = 0; i < items.length; i++) {
            var it = items[i], s = gcutT(it.start), recorded = false;
            if (gcutT(it.end) <= startT + clock.half || s >= endT - clock.half) continue;
            for (var j = 0; j < spec.items.length; j++) {
                var x = spec.items[j];
                if (x.kind === "audio" && x.trackIndex === t && it.start.ticks === String(x.startTicks)) recorded = true;
            }
            if (!recorded) throw new Error("Something was added under the clips on " + gcutLabel("audio", t) + " since Analyse. Analyse again.");
        }
    }
}

/**
 * Relative kept spans (seconds) → whole-frame pieces [{t0S, durT}] on the sequence grid. Nothing
 * is laid past the range: a piece ending even a frame later would overwrite the first frame of
 * whatever starts at the range end, outside the stretch the intact check looks at. So a piece
 * is shortened to end at the range end, in its source and on the timeline.
 */
function gcutPieces(spans, durationS, clock) {
    if (!gcutIsArray(spans) || !spans.length) throw new Error("There's nothing to keep, so nothing was changed.");
    var out = [], prevEnd = -clock.frameS, rangeFrames = Math.round(durationS / clock.frameS), laidFrames = 0;
    for (var i = 0; i < spans.length; i++) {
        var s = spans[i];
        if (!(s.end > s.start)) throw new Error("A kept span is empty or backwards. Nothing was changed.");
        if (s.start < -clock.frameS || s.end > durationS + clock.frameS) throw new Error("A kept span falls outside the clips. Nothing was changed.");
        if (s.start < prevEnd - clock.frameS / 2) throw new Error("Kept spans overlap or are out of order. Nothing was changed.");
        var t0 = Math.round(s.start / clock.frameS) * clock.frameS, frames = Math.round((s.end - t0) / clock.frameS);
        frames = Math.min(frames, Math.round((durationS - t0) / clock.frameS), rangeFrames - laidFrames);
        if (frames < 1) throw new Error("A kept span is shorter than a frame. Nothing was changed.");
        out.push({ t0S: t0, durT: frames * clock.tpf });
        laidFrames += frames;
        prevEnd = s.end;
    }
    return out;
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
 * Lay one recorded item's pieces back to back on its own track, from its own source. `rec`
 * (optional) has rebuiltEndT pushed out before each piece, so a failure part-way rolls back
 * everything laid so far, wherever it reached.
 */
function gcutLayItem(seq, f, pieces, startT, clock, rec) {
    var track = gcutKindTracks(seq, f.kind)[f.trackIndex], cursorT = startT;
    for (var p = 0; p < pieces.length; p++) {
        if (rec) rec.rebuiltEndT = Math.max(rec.rebuiltEndT, cursorT + pieces[p].durT);
        // Premiere rounds set points down to the source frame grid, so aim at a source frame;
        // a quarter frame later is the fallback when floating-point error rounds it a frame low.
        var srcIn = Math.round((f.inS + pieces[p].t0S) / f.srcFrameS) * f.srcFrameS;
        var srcOut = srcIn + pieces[p].durT / GCUT_TICKS, nudge = f.srcFrameS / 4;
        try { gcutSetRange(f.pi, srcIn, srcOut, clock.frameS / 2); }
        catch (rangeErr) { gcutSetRange(f.pi, srcIn + nudge, srcOut + nudge, clock.frameS / 2); }
        track.overwriteClip(f.pi, String(cursorT));
        cursorT += pieces[p].durT;
    }
    return cursorT;
}

/** null if every piece of `f` sits where planned; otherwise what's wrong. */
function gcutVerifyItems(seq, f, pieces, startT, clock) {
    var items = gcutItems(gcutKindTracks(seq, f.kind)[f.trackIndex]), cursorT = startT;
    for (var p = 0; p < pieces.length; p++) {
        var want = Math.round((f.inS + pieces[p].t0S) / f.srcFrameS) * f.srcFrameS, ok = 0;
        for (var i = 0; i < items.length; i++) {
            var v = items[i];
            if (gcutNode(v) === f.node && gcutNear(gcutT(v.start), cursorT, clock.half) &&
                gcutNear(gcutT(v.end) - gcutT(v.start), pieces[p].durT, clock.half) &&
                gcutNear(v.inPoint.seconds, want, clock.frameS / 2)) ok++;
        }
        if (ok !== 1) return "Kept span " + (p + 1) + " of " + pieces.length + " on " + f.label + " didn't land where or as expected.";
        cursorT += pieces[p].durT;
    }
    return null;
}

/**
 * Label of a track holding one of our sources inside [fromT, toT] where no recorded item of that
 * source belongs (audio a camera angle brought along that didn't come off), or null.
 */
function gcutStrayLeft(seq, found, fromT, toT, clock, others) {
    var tracks = gcutTracks(seq), nodes = [], f;
    for (f = 0; f < found.length; f++) nodes.push(found[f].node);
    for (var t = 0; t < tracks.length; t++) {
        var items = gcutItems(tracks[t].track);
        for (var i = 0; i < items.length; i++) {
            var it = items[i], n = gcutNode(it), s = gcutT(it.start);
            if (!gcutHasNode(nodes, n) || gcutKept(others, t, s, n)) continue;
            if (gcutT(it.end) <= fromT + clock.half || s >= toT - clock.half) continue;
            if (!gcutHome(found, n, tracks[t])) return tracks[t].label;
        }
    }
    return null;
}

/** True if a recorded item of source `n` lives on this track (an entry of gcutTracks). */
function gcutHome(found, n, track) {
    for (var f = 0; f < found.length; f++) {
        if (found[f].node === n && (found[f].kind === "audio") === track.audio && found[f].trackIndex === track.index) return true;
    }
    return false;
}

/** Lay every item: video first, then remove stray audio the video brought along, then audio. */
function gcutLayAll(seq, found, pieces, startT, endT, clock, others, rec) {
    var i, endAt = startT;
    for (i = 0; i < found.length; i++) if (found[i].kind === "video") endAt = gcutLayItem(seq, found[i], pieces, startT, clock, rec);
    gcutRemoveStrayAudio(seq, found, startT, Math.max(endAt, endT), clock, others);
    for (i = 0; i < found.length; i++) if (found[i].kind === "audio") endAt = gcutLayItem(seq, found[i], pieces, startT, clock, rec);
    return endAt;
}

/**
 * True if `f`'s source still sits on its own track inside the gap [fromT, toT): an original
 * whose remove() silently did nothing leaves its tail there, and Close gap would then move it.
 */
function gcutTailLeft(seq, f, fromT, toT, clock) {
    var items = gcutItems(gcutKindTracks(seq, f.kind)[f.trackIndex]);
    for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (gcutNode(it) === f.node && gcutT(it.start) < toT - clock.half && gcutT(it.end) > fromT + clock.half) return true;
    }
    return false;
}

/**
 * Remove audio of our sources in [fromT, toT] that isn't in `others`. Audio on a track where a
 * recorded audio item of that source lives stays: laying that item overwrites it exactly, and
 * removing it could take its linked video piece along on builds where remove() acts on partners.
 */
function gcutRemoveStrayAudio(seq, found, fromT, toT, clock, others) {
    var tracks = gcutTracks(seq), nodes = [], f;
    for (f = 0; f < found.length; f++) nodes.push(found[f].node);
    for (var t = 0; t < tracks.length; t++) {
        if (!tracks[t].audio) continue;
        var items = gcutItems(tracks[t].track);
        for (var i = items.length - 1; i >= 0; i--) {
            var it = items[i], n = gcutNode(it), s = gcutT(it.start);
            if (gcutHasNode(nodes, n) && !gcutKept(others, t, s, n) && !gcutHome(found, n, tracks[t]) &&
                s >= fromT - clock.half && gcutT(it.end) <= toT + clock.half) it.remove(false, false);
        }
    }
}

/** Put every recorded item back as it was (Restore and rollback). True if verifiably back. */
function gcutRelayAll(seq, rec, clock, others) {
    var nodes = [], i, whole = [{ t0S: 0, durT: rec.endT - rec.startT }];
    for (i = 0; i < rec.items.length; i++) nodes.push(rec.items[i].node);
    gcutRemoveRange(seq, nodes, rec.startT, Math.max(rec.rebuiltEndT, rec.endT), clock, others);
    gcutLayAll(seq, rec.items, whole, rec.startT, rec.endT, clock, others, rec);
    for (i = 0; i < rec.items.length; i++) if (gcutVerifyItems(seq, rec.items[i], whole, rec.startT, clock)) return false;
    return !gcutStrayLeft(seq, rec.items, rec.startT, rec.endT, clock, others);
}

/**
 * spec: { sequenceId, startTicks, endTicks, items: [{kind, trackIndex, startTicks, endTicks}],
 *         spans: [{start, end}] } — the gcutSnapshotSelection record; spans in seconds relative
 * to startTicks. Stash: "m@" + startTicks.
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
        gcutAudioAdded(seq, spec, startT, endT, clock);
        var pieces = gcutPieces(spec.spans, (endT - startT) / GCUT_TICKS, clock);
        var others = gcutOthers(seq, found, startT, endT);
        for (k = 0; k < found.length; k++) {
            var seen = false;
            for (var m = 0; m < marks.length; m++) if (marks[m].node === found[k].node) seen = true;
            if (!seen) marks.push({ pi: found[k].pi, node: found[k].node, inS: found[k].pi.getInPoint().seconds, outS: found[k].pi.getOutPoint().seconds });
        }
        var key = "m@" + spec.startTicks;
        var rec = { sequenceId: gcutSeqId(seq), startT: startT, endT: endT, rebuiltEndT: endT, gapClosed: false,
                    items: found, others: others };
        // A new Apply at the same start replaces the earlier record (that Restore is meaningless once
        // the timeline changed again); if this one rolls back cleanly, the earlier record comes back.
        var stash = gcutState().gcutStash, hadPrev = stash.hasOwnProperty(key), prev = stash[key];
        stash[key] = rec; // written before anything changes, so it can always be rolled back
        try {
            for (k = 0; k < found.length; k++) found[k].item.remove(false, false);
            var nodes = [];
            for (k = 0; k < found.length; k++) nodes.push(found[k].node);
            gcutRemoveRange(seq, nodes, startT, endT, clock, others); // linked partners some builds leave behind
            var endAt = gcutLayAll(seq, found, pieces, startT, endT, clock, others, rec);
            for (k = 0; k < found.length; k++) {
                var bad = gcutVerifyItems(seq, found[k], pieces, startT, clock);
                if (bad) throw new Error(bad);
                if (gcutTailLeft(seq, found[k], endAt, endT, clock)) {
                    throw new Error("The original clip on " + found[k].label + " didn't come off the timeline: part of it is still in the gap.");
                }
            }
            var stray = gcutStrayLeft(seq, found, startT, Math.max(endAt, endT), clock, others);
            if (stray) throw new Error("Audio a camera angle brought along couldn't be removed from " + stray + ".");
            var hit = gcutSnapshotIntact(seq, others, clock);
            if (hit) throw new Error("The rebuild overwrote something on " + hit + ".");
            rec.rebuiltEndT = Math.max(endAt, startT); // verified: the rebuild ends exactly here
            return gcutOk({ ok: true, appliedCount: pieces.length, clipCount: found.length,
                expectedDuration: (endAt - startT) / GCUT_TICKS, actualDuration: (endAt - startT) / GCUT_TICKS,
                trailingGapS: (endT - endAt) / GCUT_TICKS });
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

/** Our rebuilt pieces on the timeline now: each recorded source on its own track inside [fromT, toT]. */
function gcutOursNow(seq, rec, fromT, toT, clock) {
    var ours = [];
    for (var i = 0; i < rec.items.length; i++) {
        var f = rec.items[i], tracks = gcutKindTracks(seq, f.kind);
        if (f.trackIndex >= tracks.numTracks) throw new Error(f.label + " no longer exists. Use Premiere's Undo instead.");
        var items = gcutItems(tracks[f.trackIndex]);
        for (var j = 0; j < items.length; j++) {
            var it = items[j], s = gcutT(it.start);
            if (gcutNode(it) === f.node && s >= fromT - clock.half && gcutT(it.end) <= toT + clock.half) {
                ours.push({ kind: f.kind, trackIndex: f.trackIndex, startT: s });
            }
        }
    }
    return ours;
}

/**
 * Restore re-lays every recorded clip over the whole range on its own track (and the camera
 * angles may bring their audio along, onto any audio track). Refuse if anything that wasn't there
 * at Apply now sits where that would overwrite it: anywhere in the range on a recorded track or
 * any audio track, or in the gap on any track. Returns the refusal, or null.
 */
function gcutInTheWay(seq, rec, others, clock) {
    var tracks = gcutTracks(seq);
    for (var i = 0; i < others.length; i++) {
        var o = others[i], guarded = tracks[o.t].audio;
        if (gcutKept(rec.others, o.t, o.start, o.node)) continue;
        for (var j = 0; j < rec.items.length; j++) {
            if ((rec.items[j].kind === "audio") === tracks[o.t].audio && rec.items[j].trackIndex === tracks[o.t].index) guarded = true;
        }
        if (o.end > rec.rebuiltEndT + clock.half && o.start < rec.endT - clock.half) {
            return "Something was placed in the gap on " + o.label + " since, and restoring would overwrite it. Use Premiere's Undo instead.";
        }
        if (guarded && o.start < rec.endT - clock.half) {
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
        var ours = gcutOursNow(seq, rec, rec.startT, rec.rebuiltEndT, clock);
        var others = gcutOthers(seq, ours, rec.startT, Math.max(rec.rebuiltEndT, rec.endT));
        var blocked = gcutInTheWay(seq, rec, others, clock);
        if (blocked) throw new Error(blocked);
        for (k = 0; k < rec.items.length; k++) {
            var seen = false;
            for (var m = 0; m < marks.length; m++) if (marks[m].node === rec.items[k].node) seen = true;
            if (!seen) marks.push({ pi: rec.items[k].pi, node: rec.items[k].node, inS: rec.items[k].pi.getInPoint().seconds, outS: rec.items[k].pi.getOutPoint().seconds });
        }
        // Relaying grows rec.rebuiltEndT as pieces land; if Restore fails, the record must still
        // describe the edit on the timeline, so Close gap still sees the gap.
        var rebuiltEndT = rec.rebuiltEndT;
        try {
            if (!gcutRelayAll(seq, rec, clock, others)) throw new Error("The original clips didn't go back as expected. Use Premiere's Undo.");
            var hit = gcutSnapshotIntact(seq, others, clock);
            if (hit) throw new Error("Restoring changed something on " + hit + ". Use Premiere's Undo.");
        } catch (inner) {
            rec.rebuiltEndT = rebuiltEndT;
            throw inner;
        }
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

/**
 * Ripple everything after the gap left by the gap's length, on every track, so sync holds
 * across tracks. Refuses if anything sits inside the gap or a track with later clips is
 * locked. Items already moved as a linked partner are not moved twice.
 * spec: { startTicks } — the range start recorded at Analyse.
 */
function gcutCloseGapMulti(specJson) {
    try {
        var spec = gcutParse(specJson);
        var seq = gcutSequence(), clock = gcutClock(seq);
        var rec = gcutRecord(seq, spec, "There's no Genius Cut edit on these clips in this session.");
        if (rec.gapClosed) return gcutOk({ ok: true, movedCount: 0 });
        var gapStartT = rec.rebuiltEndT, gapEndT = rec.endT, gapT = gapEndT - gapStartT;
        if (gapT <= clock.half) return gcutOk({ ok: true, movedCount: 0 });

        var movers = [], tracks = gcutTracks(seq), t, i, it;
        for (t = 0; t < tracks.length; t++) {
            var items = gcutItems(tracks[t].track), later = false;
            for (i = 0; i < items.length; i++) {
                it = items[i];
                var s = gcutT(it.start), e = gcutT(it.end);
                if (e > gapStartT + clock.half && s < gapEndT - clock.half) {
                    throw new Error("Something on " + tracks[t].label + " sits inside the gap, so it wasn't closed. Close it by hand.");
                }
                if (s >= gapEndT - clock.half) { movers.push({ item: it, target: s - gapT, label: tracks[t].label }); later = true; }
            }
            if (later && typeof tracks[t].track.isLocked === "function" && tracks[t].track.isLocked()) {
                throw new Error(tracks[t].label + " is locked, so the gap wasn't closed. Unlock it and try again.");
            }
        }
        rec.gapClosed = true; // from here on Restore must not run: later clips may have moved
        var offset = gcutTimeFromTicks(-gapT);
        for (i = 0; i < movers.length; i++) {
            if (!gcutNear(gcutT(movers[i].item.start), movers[i].target, clock.half)) movers[i].item.move(offset);
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
