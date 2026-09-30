/*
 * Genius Cut — ExtendScript host (Premiere Pro). ES3: no JSON, let/const, arrows or Array extras.
 *
 * Every global is prefixed `gcut`: ExtendScript has one global namespace shared by every
 * CEP panel in Premiere (PR Extension included).
 *
 * Contract with the panel (extension/client/src/api/host.ts):
 *   - each gcut* function takes JSON-encoded string arguments and returns a JSON string;
 *   - failures return "Error: <message>" and never throw.
 *
 * Timeline edits follow plan decision D2: remove the clip and re-lay the kept source spans
 * with overwriteClip (no razor: Premiere 2026 silently no-ops the QE razor), then verify
 * the rebuilt duration. Reclaimed time stays as a trailing gap until Close gap.
 *
 * Unverified against real Premiere until Checkpoint B (the docs are silent or contradictory):
 *   - setInPoint/setOutPoint units (docs say ticks for one, seconds for the other). We set,
 *     read back, and fall back to the other unit.
 *   - where overwriteClip puts linked audio. We check afterwards and report a mismatch.
 */

var GCUT_TICKS = 254016000000; // Premiere ticks per second. Every conversion goes through this.
var GCUT_ALL_MEDIA = 4;

// ── JSON (ExtendScript has none) ────────────────────────────────────────────────────

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
        if (v.hasOwnProperty(k) && typeof v[k] !== "function") parts.push(gcutQuote(k) + ":" + gcutStringify(v[k]));
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

function gcutIsArray(v) { return Object.prototype.toString.call(v) === "[object Array]"; }

function gcutOk(obj) { return gcutStringify(obj); }
function gcutFail(e) { return "Error: " + (e && e.message ? e.message : String(e)); }

// ── time ────────────────────────────────────────────────────────────────────────────

function gcutTicks(seconds) { return String(Math.round(seconds * GCUT_TICKS)); }
function gcutSeconds(ticks) { return Number(ticks) / GCUT_TICKS; }
function gcutTimeFromSeconds(seconds) { var t = new Time(); t.seconds = seconds; return t; }

// ── lookups ─────────────────────────────────────────────────────────────────────────

function gcutSequence() {
    if (!app.project) throw new Error("No project is open.");
    var seq = app.project.activeSequence;
    if (!seq) throw new Error("No active sequence. Open the sequence with the clip first.");
    return seq;
}

function gcutFps(seq) { return GCUT_TICKS / Number(seq.timebase); }

function gcutItems(track) {
    var list = [];
    for (var i = 0; i < track.clips.numItems; i++) list.push(track.clips[i]);
    return list;
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

function gcutFindVideoItem(seq, trackIndex, startTicks) {
    if (trackIndex < 0 || trackIndex >= seq.videoTracks.numTracks) throw new Error("That video track no longer exists.");
    var items = gcutItems(seq.videoTracks[trackIndex]);
    for (var i = 0; i < items.length; i++) {
        if (items[i].start.ticks === startTicks) return items[i];
    }
    throw new Error("The clip has moved or changed since it was analysed. Analyse it again.");
}

/** Audio track items that belong with a video item: same source, same timeline position. */
function gcutLinkedAudio(seq, videoItem) {
    var found = [], node = videoItem.projectItem.nodeId;
    for (var t = 0; t < seq.audioTracks.numTracks; t++) {
        var items = gcutItems(seq.audioTracks[t]);
        for (var i = 0; i < items.length; i++) {
            var a = items[i];
            if (a.projectItem && a.projectItem.nodeId === node &&
                a.start.ticks === videoItem.start.ticks && a.end.ticks === videoItem.end.ticks) {
                found.push({ track: t, item: a });
            }
        }
    }
    return found;
}

// ── setting source in/out, whichever unit this Premiere build wants ─────────────────

function gcutSetPoint(pi, which, seconds, frameS) {
    var setter = which === "in" ? "setInPoint" : "setOutPoint";
    var getter = which === "in" ? "getInPoint" : "getOutPoint";
    var close = function () { return Math.abs(pi[getter]().seconds - seconds) <= frameS / 2; };
    pi[setter](seconds, GCUT_ALL_MEDIA);
    if (close()) return;
    pi[setter](gcutTicks(seconds), GCUT_ALL_MEDIA);
    if (close()) return;
    throw new Error("Premiere didn't accept the " + which + " point " + seconds.toFixed(3) + " s.");
}

// ── gcutFindClip ────────────────────────────────────────────────────────────────────

/** name: "" = use the selected clip. */
function gcutFindClip(nameJson) {
    try {
        var name = gcutParse(nameJson) || "";
        var seq = gcutSequence();
        var candidates = [], selected = [];
        for (var t = 0; t < seq.videoTracks.numTracks; t++) {
            var items = gcutItems(seq.videoTracks[t]);
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                if (!it.projectItem) continue;
                var sel = typeof it.isSelected === "function" && it.isSelected();
                var hit = name === "" ? sel : gcutNameMatches(it.name, name);
                if (hit) {
                    candidates.push({ item: it, track: t });
                    if (sel) selected.push({ item: it, track: t });
                }
            }
        }
        if (!candidates.length) {
            return gcutOk({ found: false, name: name,
                message: name === "" ? "No clip is selected in the timeline." : "No clip named " + name + " on the active sequence." });
        }
        var chosen = selected.length ? selected[0] : candidates[0];
        var c = chosen.item;
        return gcutOk({
            found: true,
            name: c.name,
            mediaPath: c.projectItem.getMediaPath(),
            trackIndex: chosen.track,
            startTicks: c.start.ticks,
            inS: c.inPoint.seconds,
            outS: c.outPoint.seconds,
            startS: c.start.seconds,
            fps: Math.round(gcutFps(seq) * 1000) / 1000,
            matchCount: candidates.length,
            selectedUsed: selected.length > 0,
            speed: gcutSpeed(c)
        });
    } catch (e) {
        return gcutFail(e);
    }
}

// ── gcutApplyCuts ───────────────────────────────────────────────────────────────────

if (typeof $ !== "undefined" && $.global && !$.global.gcutStash) $.global.gcutStash = {};
function gcutStash() { return $.global.gcutStash; }
function gcutKey(trackIndex, startTicks) { return "v" + trackIndex + "@" + startTicks; }

function gcutValidateSpans(spans, inS, outS, frameS) {
    if (!gcutIsArray(spans) || !spans.length) throw new Error("There's nothing to keep, so nothing was changed.");
    var prevEnd = inS - frameS;
    for (var i = 0; i < spans.length; i++) {
        var s = spans[i];
        if (!(s.end > s.start)) throw new Error("A kept span is empty or backwards. Nothing was changed.");
        if (s.start < inS - frameS || s.end > outS + frameS) throw new Error("A kept span falls outside the clip. Nothing was changed.");
        if (s.start < prevEnd - frameS / 2) throw new Error("Kept spans overlap or are out of order. Nothing was changed.");
        prevEnd = s.end;
    }
}

/** spec: { trackIndex, startTicks, spans: [{start, end}] } — spans in SOURCE seconds. */
function gcutApplyCuts(specJson) {
    try {
        var spec = gcutParse(specJson);
        var seq = gcutSequence();
        var frameS = 1 / gcutFps(seq);
        var item = gcutFindVideoItem(seq, spec.trackIndex, spec.startTicks);
        if (Math.abs(gcutSpeed(item) - 1) > 1e-6) throw new Error("This clip isn't at 100% speed. Nothing was changed.");
        gcutValidateSpans(spec.spans, item.inPoint.seconds, item.outPoint.seconds, frameS);

        var pi = item.projectItem;
        var track = seq.videoTracks[spec.trackIndex];
        var audio = gcutLinkedAudio(seq, item);
        var original = {
            trackIndex: spec.trackIndex,
            startTicks: item.start.ticks,
            startS: item.start.seconds,
            endS: item.end.seconds,
            inS: item.inPoint.seconds,
            outS: item.outPoint.seconds,
            audioTracks: [],
            binInS: pi.getInPoint().seconds,
            binOutS: pi.getOutPoint().seconds
        };
        for (var a = 0; a < audio.length; a++) original.audioTracks.push(audio[a].track);

        // 1. Take the original off the timeline (video and its linked audio), no ripple.
        item.remove(false, false);
        for (a = 0; a < audio.length; a++) audio[a].item.remove(false, false);

        // 2. Re-lay each kept span, in order, from the clip's original start.
        var cursor = original.startS, expected = 0, placed = [];
        for (var i = 0; i < spec.spans.length; i++) {
            var s = spec.spans[i];
            gcutSetPoint(pi, "in", s.start, frameS);
            gcutSetPoint(pi, "out", s.end, frameS);
            track.overwriteClip(pi, gcutTicks(cursor));
            placed.push(gcutTicks(cursor));
            cursor += s.end - s.start;
            expected += s.end - s.start;
        }

        // 3. Leave the bin item exactly as it was.
        gcutSetPoint(pi, "in", original.binInS, frameS);
        gcutSetPoint(pi, "out", original.binOutS, frameS);

        // 4. Verify: what's on the track now must add up to what we meant to keep.
        var actual = 0, count = 0, vItems = gcutItems(track);
        for (i = 0; i < vItems.length; i++) {
            var v = vItems[i];
            if (v.projectItem && v.projectItem.nodeId === pi.nodeId &&
                v.start.seconds >= original.startS - frameS / 2 && v.end.seconds <= cursor + frameS / 2) {
                actual += v.end.seconds - v.start.seconds;
                count++;
            }
        }
        var audioProblem = "";
        for (a = 0; a < original.audioTracks.length; a++) {
            var at = original.audioTracks[a], aSum = 0, aItems = gcutItems(seq.audioTracks[at]);
            for (i = 0; i < aItems.length; i++) {
                var ai = aItems[i];
                if (ai.projectItem && ai.projectItem.nodeId === pi.nodeId &&
                    ai.start.seconds >= original.startS - frameS / 2 && ai.end.seconds <= cursor + frameS / 2) {
                    aSum += ai.end.seconds - ai.start.seconds;
                }
            }
            if (Math.abs(aSum - expected) > frameS) audioProblem = "The linked audio didn't land back on A" + (at + 1) + ".";
        }

        gcutStash()[gcutKey(spec.trackIndex, original.startTicks)] = { original: original, rebuiltEndS: cursor, nodeId: pi.nodeId };

        var durationOk = count === spec.spans.length && Math.abs(actual - expected) <= frameS;
        var ok = durationOk && !audioProblem;
        return gcutOk({
            ok: ok,
            appliedCount: count,
            expectedDuration: expected,
            actualDuration: actual,
            trailingGapS: (original.endS - original.startS) - expected,
            // The video mismatch is the root cause when both fail (a lost span loses its audio too).
            message: ok ? undefined : (!durationOk
                ? "The rebuilt clip doesn't match what was meant to be kept. Nothing was hidden: check the timeline, or restore the original."
                : audioProblem)
        });
    } catch (e) {
        return gcutFail(e);
    }
}

// ── gcutRestoreOriginal ─────────────────────────────────────────────────────────────

function gcutRemoveRebuilt(seq, rec) {
    var o = rec.original, frameS = 1 / gcutFps(seq);
    var tracks = [seq.videoTracks[o.trackIndex]];
    for (var a = 0; a < o.audioTracks.length; a++) tracks.push(seq.audioTracks[o.audioTracks[a]]);
    for (var t = 0; t < tracks.length; t++) {
        var items = gcutItems(tracks[t]);
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (it.projectItem && it.projectItem.nodeId === rec.nodeId &&
                it.start.seconds >= o.startS - frameS / 2 && it.end.seconds <= rec.rebuiltEndS + frameS / 2) {
                it.remove(false, false);
            }
        }
    }
}

/** spec: { trackIndex, startTicks } — the ORIGINAL clip's identity from gcutFindClip. */
function gcutRestoreOriginal(specJson) {
    try {
        var spec = gcutParse(specJson);
        var rec = gcutStash()[gcutKey(spec.trackIndex, spec.startTicks)];
        if (!rec) throw new Error("There's no Genius Cut edit to restore for this clip in this session. Use Premiere's Undo.");
        if (rec.gapClosed) throw new Error("The gap was already closed, so later clips moved. Use Premiere's Undo to go back.");
        var seq = gcutSequence(), o = rec.original, frameS = 1 / gcutFps(seq);
        var pi = null, vItems = gcutItems(seq.videoTracks[o.trackIndex]);
        for (var i = 0; i < vItems.length; i++) {
            if (vItems[i].projectItem && vItems[i].projectItem.nodeId === rec.nodeId) { pi = vItems[i].projectItem; break; }
        }
        if (!pi) throw new Error("The rebuilt clip can't be found on the timeline any more.");
        gcutRemoveRebuilt(seq, rec);
        gcutSetPoint(pi, "in", o.inS, frameS);
        gcutSetPoint(pi, "out", o.outS, frameS);
        seq.videoTracks[o.trackIndex].overwriteClip(pi, gcutTicks(o.startS));
        gcutSetPoint(pi, "in", o.binInS, frameS);
        gcutSetPoint(pi, "out", o.binOutS, frameS);
        delete gcutStash()[gcutKey(spec.trackIndex, spec.startTicks)];
        return gcutOk({ ok: true });
    } catch (e) {
        return gcutFail(e);
    }
}

// ── gcutCloseTrailingGap ────────────────────────────────────────────────────────────

/**
 * Ripple everything after the gap left by the gap's length, on every track, so sync
 * holds across tracks. Refuses if anything on any track sits inside the gap.
 */
function gcutCloseTrailingGap(specJson) {
    try {
        var spec = gcutParse(specJson);
        var rec = gcutStash()[gcutKey(spec.trackIndex, spec.startTicks)];
        if (!rec) throw new Error("There's no Genius Cut edit on this clip in this session.");
        if (rec.gapClosed) return gcutOk({ ok: true, movedCount: 0 });
        var seq = gcutSequence(), frameS = 1 / gcutFps(seq);
        var gapStart = rec.rebuiltEndS, gapEnd = rec.original.endS, gap = gapEnd - gapStart;
        if (gap <= frameS / 2) return gcutOk({ ok: true, movedCount: 0 });

        var all = [], t, i, it, tracks = [];
        for (t = 0; t < seq.videoTracks.numTracks; t++) tracks.push({ track: seq.videoTracks[t], label: "V" + (t + 1) });
        for (t = 0; t < seq.audioTracks.numTracks; t++) tracks.push({ track: seq.audioTracks[t], label: "A" + (t + 1) });
        for (t = 0; t < tracks.length; t++) {
            var items = gcutItems(tracks[t].track);
            for (i = 0; i < items.length; i++) {
                it = items[i];
                var s = it.start.seconds, e = it.end.seconds;
                if (e > gapStart + frameS / 2 && s < gapEnd - frameS / 2) {
                    throw new Error("Something on " + tracks[t].label + " sits inside the gap, so it wasn't closed. Close it by hand.");
                }
                if (s >= gapEnd - frameS / 2) all.push(it);
            }
        }
        var offset = gcutTimeFromSeconds(-gap);
        for (i = 0; i < all.length; i++) all[i].move(offset);
        rec.gapClosed = true;
        return gcutOk({ ok: true, movedCount: all.length });
    } catch (e) {
        return gcutFail(e);
    }
}

function gcutHostVersion() {
    return "0.1.0";
}
