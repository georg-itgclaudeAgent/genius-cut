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
 * Timeline edits follow plan decision D2: remove the clip and re-lay the kept source spans
 * with overwriteClip (no razor: Premiere 2026 silently no-ops the QE razor). Consequences:
 *   - The rebuild lays fresh clips from the source, so effects, grades, keyframes and audio
 *     gain on the original are NOT carried over. gcutFindClip names any effects it finds so
 *     the panel can warn before Apply.
 *   - Apply is all-or-nothing: every span is checked as it lands, and any failure rolls back
 *     to the original clip. The bin item's own in/out marks are always restored.
 *   - Clips it can't rebuild safely are refused before anything changes: retimed clips,
 *     J/L cuts (audio split or extended past the video) and clips without linked audio.
 *
 * Unverified against real Premiere until Checkpoint B (docs silent or contradictory):
 *   - setInPoint/setOutPoint units (docs say ticks for one, seconds for the other): set,
 *     read back, fall back to the other unit, and remember which worked;
 *   - where overwriteClip puts linked audio: checked afterwards, never assumed;
 *   - whether remove()/move() also act on linked partners: handled either way.
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

function gcutFindVideoItem(seq, trackIndex, startTicks) {
    if (trackIndex < 0 || trackIndex >= seq.videoTracks.numTracks) throw new Error("That video track no longer exists.");
    var items = gcutItems(seq.videoTracks[trackIndex]);
    for (var i = 0; i < items.length; i++) {
        if (items[i].start.ticks === startTicks) return items[i];
    }
    throw new Error("The clip has moved or changed since it was analysed. Analyse it again.");
}

/** Audio items exactly linked to a video item: same source, same start and end. */
function gcutExactAudio(seq, node, startT, endT) {
    var found = [];
    for (var t = 0; t < seq.audioTracks.numTracks; t++) {
        var items = gcutItems(seq.audioTracks[t]);
        for (var i = 0; i < items.length; i++) {
            var a = items[i];
            if (gcutNode(a) === node && gcutT(a.start) === startT && gcutT(a.end) === endT) found.push({ track: t, item: a });
        }
    }
    return found;
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

// ── gcutFindClip ────────────────────────────────────────────────────────────────────

/** name: "" = use the selected clip. */
function gcutFindClip(nameJson) {
    try {
        var name = gcutParse(nameJson) || "";
        var seq = gcutSequence(), clock = gcutClock(seq);
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
        var effects = [];
        gcutEffects(c, GCUT_VIDEO_INTRINSIC, effects);
        var audio = gcutExactAudio(seq, gcutNode(c), gcutT(c.start), gcutT(c.end));
        for (var a = 0; a < audio.length; a++) gcutEffects(audio[a].item, GCUT_AUDIO_INTRINSIC, effects);
        return gcutOk({
            found: true,
            name: c.name,
            mediaPath: c.projectItem.getMediaPath(),
            trackIndex: chosen.track,
            startTicks: c.start.ticks,
            inS: c.inPoint.seconds,
            outS: c.outPoint.seconds,
            startS: c.start.seconds,
            fps: Math.round(clock.fps * 1000) / 1000,
            matchCount: candidates.length,
            selectedUsed: selected.length > 0,
            speed: gcutSpeed(c),
            effects: effects
        });
    } catch (e) {
        return gcutFail(e);
    }
}

// ── gcutApplyCuts ───────────────────────────────────────────────────────────────────

function gcutKey(trackIndex, startTicks) { return "v" + trackIndex + "@" + startTicks; }

/** Kept spans → whole-frame placements: [{inS, outS, frames}] in source seconds. */
function gcutPlan(spans, inS, outS, clock) {
    if (!gcutIsArray(spans) || !spans.length) throw new Error("There's nothing to keep, so nothing was changed.");
    var plan = [], prevEnd = inS - clock.frameS;
    for (var i = 0; i < spans.length; i++) {
        var s = spans[i];
        if (!(s.end > s.start)) throw new Error("A kept span is empty or backwards. Nothing was changed.");
        if (s.start < inS - clock.frameS || s.end > outS + clock.frameS) throw new Error("A kept span falls outside the clip. Nothing was changed.");
        if (s.start < prevEnd - clock.frameS / 2) throw new Error("Kept spans overlap or are out of order. Nothing was changed.");
        var frames = Math.round((s.end - s.start) / clock.frameS);
        if (frames < 1) throw new Error("A kept span is shorter than a frame. Nothing was changed.");
        plan.push({ inS: s.start, outS: s.start + frames * clock.frameS, frames: frames });
        prevEnd = s.end;
    }
    return plan;
}

/** Everything that isn't ours overlapping [startT, endT), on every track. */
function gcutSnapshot(seq, node, startT, endT) {
    var snap = [], tracks = gcutTracks(seq);
    for (var t = 0; t < tracks.length; t++) {
        var items = gcutItems(tracks[t].track);
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (gcutNode(it) === node) continue;
            var s = gcutT(it.start), e = gcutT(it.end);
            if (e > startT && s < endT) snap.push({ label: tracks[t].label, t: t, start: s, end: e, inS: it.inPoint.seconds, node: gcutNode(it) });
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

/** Remove every item of this source inside [fromT, toT] on every track, last first. */
function gcutRemoveOurs(seq, node, fromT, toT, clock) {
    var tracks = gcutTracks(seq);
    for (var t = 0; t < tracks.length; t++) {
        var items = gcutItems(tracks[t].track);
        for (var i = items.length - 1; i >= 0; i--) {
            var it = items[i];
            if (gcutNode(it) === node && gcutT(it.start) >= fromT - clock.half && gcutT(it.end) <= toT + clock.half) {
                it.remove(false, false);
            }
        }
    }
}

/** Our source's items sitting inside [fromT, toT], per track label. */
function gcutOursByTrack(seq, node, fromT, toT, clock) {
    var out = {}, tracks = gcutTracks(seq);
    for (var t = 0; t < tracks.length; t++) {
        var items = gcutItems(tracks[t].track), sum = 0, n = 0;
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (gcutNode(it) === node && gcutT(it.start) >= fromT - clock.half && gcutT(it.end) <= toT + clock.half) {
                sum += gcutT(it.end) - gcutT(it.start); n++;
            }
        }
        if (n) out[tracks[t].label] = { ticks: sum, count: n, audio: tracks[t].audio, index: tracks[t].index };
    }
    return out;
}

/** Remove whatever we laid and re-lay the original clip; true if it's verifiably back. */
function gcutRelayOriginal(seq, rec, clock) {
    var o = rec.original, pi = rec.pi;
    gcutRemoveOurs(seq, o.node, o.startT, Math.max(rec.rebuiltEndT, o.endT), clock);
    gcutSetRange(pi, o.inS, o.outS, clock.frameS / 2);
    seq.videoTracks[o.trackIndex].overwriteClip(pi, String(o.startT));
    var items = gcutItems(seq.videoTracks[o.trackIndex]);
    for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (gcutNode(it) === o.node && gcutNear(gcutT(it.start), o.startT, clock.half) &&
            gcutNear(gcutT(it.end), o.endT, clock.half) && gcutNear(it.inPoint.seconds, o.inS, clock.frameS / 2)) return true;
    }
    return false;
}

/** spec: { trackIndex, startTicks, spans: [{start, end}] } — spans in SOURCE seconds. */
function gcutApplyCuts(specJson) {
    var seq, clock, rec, pi, binIn, binOut, key;
    try {
        var spec = gcutParse(specJson);
        seq = gcutSequence();
        clock = gcutClock(seq);
        var item = gcutFindVideoItem(seq, spec.trackIndex, spec.startTicks);
        if (Math.abs(gcutSpeed(item) - 1) > 1e-6) throw new Error("This clip isn't at 100% speed. Nothing was changed.");
        var plan = gcutPlan(spec.spans, item.inPoint.seconds, item.outPoint.seconds, clock);

        pi = item.projectItem;
        var node = pi.nodeId, startT = gcutT(item.start), endT = gcutT(item.end);
        var t, i, a;
        for (t = 0; t < seq.audioTracks.numTracks; t++) {
            var aItems = gcutItems(seq.audioTracks[t]);
            for (i = 0; i < aItems.length; i++) {
                var ai = aItems[i];
                if (gcutNode(ai) !== node) continue;
                var s = gcutT(ai.start), e = gcutT(ai.end);
                if (!(s === startT && e === endT) && e > startT && s < endT) {
                    throw new Error("This clip's audio on A" + (t + 1) + " is split or extended past the video (a J/L cut). " +
                        "Genius Cut can't rebuild that safely yet. Nothing was changed.");
                }
            }
        }
        var linked = gcutExactAudio(seq, node, startT, endT);
        if (!linked.length) {
            throw new Error("This clip's audio isn't linked on the timeline (for example, it was replaced by a separate recording). " +
                "Genius Cut can't rebuild it safely yet. Nothing was changed.");
        }
        var audioTracks = [];
        for (a = 0; a < linked.length; a++) audioTracks.push(linked[a].track);
        var snap = gcutSnapshot(seq, node, startT, endT);

        binIn = pi.getInPoint().seconds;
        binOut = pi.getOutPoint().seconds;
        key = gcutKey(spec.trackIndex, spec.startTicks);
        // Written BEFORE anything changes, so a failure can always be rolled back.
        rec = {
            pi: pi,
            original: { trackIndex: spec.trackIndex, node: node, startT: startT, endT: endT,
                        inS: item.inPoint.seconds, outS: item.outPoint.seconds, audioTracks: audioTracks },
            rebuiltEndT: endT,
            gapClosed: false
        };
        gcutState().gcutStash[key] = rec;
        var track = seq.videoTracks[spec.trackIndex];

        try {
            // 1. Take the original off the timeline, then any linked audio that's still there.
            item.remove(false, false);
            var still = gcutExactAudio(seq, node, startT, endT);
            for (a = still.length - 1; a >= 0; a--) still[a].item.remove(false, false);

            // 2. Re-lay each kept span on whole frames, checking each as it lands.
            var cursorT = startT;
            for (var p = 0; p < plan.length; p++) {
                var span = plan[p], durT = span.frames * clock.tpf;
                gcutSetRange(pi, span.inS, span.outS, clock.frameS / 2);
                track.overwriteClip(pi, String(cursorT));
                rec.rebuiltEndT = Math.max(rec.rebuiltEndT, cursorT + durT);
                var landed = false, vItems = gcutItems(track);
                for (i = 0; i < vItems.length; i++) {
                    var v = vItems[i];
                    if (gcutNode(v) === node && gcutNear(gcutT(v.start), cursorT, clock.half) &&
                        gcutNear(gcutT(v.end) - gcutT(v.start), durT, clock.half) &&
                        gcutNear(v.inPoint.seconds, span.inS, clock.frameS / 2)) { landed = true; break; }
                }
                if (!landed) throw new Error("Kept span " + (p + 1) + " of " + plan.length + " didn't land where or as expected.");
                cursorT += durT;
            }
            rec.rebuiltEndT = cursorT;

            // 3. Audio must be back on its original tracks, and nowhere else.
            var ours = gcutOursByTrack(seq, node, startT, cursorT, clock);
            for (var label in ours) {
                if (ours.hasOwnProperty(label) && ours[label].audio) {
                    var home = false;
                    for (a = 0; a < audioTracks.length; a++) if (audioTracks[a] === ours[label].index) home = true;
                    if (!home) throw new Error("The rebuilt audio landed on " + label + " instead of A" + (audioTracks[0] + 1) + ".");
                }
            }
            for (a = 0; a < audioTracks.length; a++) {
                var got = ours["A" + (audioTracks[a] + 1)];
                if (!got || !gcutNear(got.ticks, cursorT - startT, clock.tpf)) {
                    throw new Error("The linked audio didn't land back on A" + (audioTracks[a] + 1) + ".");
                }
            }

            // 4. Nothing that isn't ours may have been touched.
            var hit = gcutSnapshotIntact(seq, snap, clock);
            if (hit) throw new Error("The rebuild overwrote something on " + hit + ".");

            return gcutOk({
                ok: true,
                appliedCount: plan.length,
                expectedDuration: (cursorT - startT) / GCUT_TICKS,
                actualDuration: (cursorT - startT) / GCUT_TICKS,
                trailingGapS: (endT - cursorT) / GCUT_TICKS
            });
        } catch (inner) {
            var back = false;
            try { back = gcutRelayOriginal(seq, rec, clock); } catch (ignored) { back = false; }
            if (back) delete gcutState().gcutStash[key];
            var damage = gcutSnapshotIntact(seq, snap, clock);
            return gcutOk({
                ok: false,
                rolledBack: back,
                appliedCount: 0,
                expectedDuration: 0,
                actualDuration: 0,
                trailingGapS: 0,
                message: inner.message +
                    (back ? " The original clip was put back." : " It couldn't be put back automatically: use Premiere's Undo.") +
                    (damage ? " Something on " + damage + " was changed too: use Undo to recover it." : "")
            });
        }
    } catch (e) {
        return gcutFail(e);
    } finally {
        // Always leave the bin item's own in/out marks as they were.
        if (pi && binIn !== undefined) {
            try { gcutSetRange(pi, binIn, binOut, clock.frameS / 2); } catch (ignored2) { /* nothing more we can do */ }
        }
    }
}

// ── gcutRestoreOriginal ─────────────────────────────────────────────────────────────

/** spec: { trackIndex, startTicks } — the ORIGINAL clip's identity from gcutFindClip. */
function gcutRestoreOriginal(specJson) {
    var pi, binIn, binOut, clock;
    try {
        var spec = gcutParse(specJson);
        var key = gcutKey(spec.trackIndex, spec.startTicks);
        var rec = gcutState().gcutStash[key];
        if (!rec) throw new Error("There's no Genius Cut edit to restore for this clip in this session. Use Premiere's Undo.");
        if (rec.gapClosed) throw new Error("The gap was already closed, so later clips moved. Use Premiere's Undo to go back.");
        var seq = gcutSequence(), o = rec.original;
        clock = gcutClock(seq);
        // Refuse rather than overwrite anything placed in the reclaimed gap since.
        var inGap = gcutSnapshot(seq, o.node, rec.rebuiltEndT, o.endT);
        if (inGap.length) {
            throw new Error("Something was placed in the gap on " + inGap[0].label + " since, and restoring would overwrite it. Use Premiere's Undo.");
        }
        pi = rec.pi;
        binIn = pi.getInPoint().seconds;
        binOut = pi.getOutPoint().seconds;
        if (!gcutRelayOriginal(seq, rec, clock)) throw new Error("The original clip didn't go back as expected. Use Premiere's Undo.");
        delete gcutState().gcutStash[key];
        return gcutOk({ ok: true });
    } catch (e) {
        return gcutFail(e);
    } finally {
        if (pi && binIn !== undefined) {
            try { gcutSetRange(pi, binIn, binOut, clock.frameS / 2); } catch (ignored) { /* best effort */ }
        }
    }
}

// ── gcutCloseTrailingGap ────────────────────────────────────────────────────────────

/**
 * Ripple everything after the gap left by the gap's length, on every track, so sync holds
 * across tracks. Refuses if anything sits inside the gap or a track with later clips is
 * locked. Items already moved as a linked partner are not moved twice.
 */
function gcutCloseTrailingGap(specJson) {
    try {
        var spec = gcutParse(specJson);
        var rec = gcutState().gcutStash[gcutKey(spec.trackIndex, spec.startTicks)];
        if (!rec) throw new Error("There's no Genius Cut edit on this clip in this session.");
        if (rec.gapClosed) return gcutOk({ ok: true, movedCount: 0 });
        var seq = gcutSequence(), clock = gcutClock(seq);
        var gapStartT = rec.rebuiltEndT, gapEndT = rec.original.endT, gapT = gapEndT - gapStartT;
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
