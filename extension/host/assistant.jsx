/*
 * Genius Cut — the Claude assistant's toolbox (personal builds only). ES3, like index.jsx.
 *
 * Kept out of index.jsx so editor packages never contain it: ExtendScript has one global namespace
 * shared by every CEP panel, so these functions exist only where the flagged panel loads this file
 * with $.evalFile, after index.jsx. It uses index.jsx's globals (gcutSequence, gcutClock, ...).
 *
 * Same contract as index.jsx: each gcutTool* takes one JSON-encoded string and returns a JSON
 * string; failures return "Error: <message>" and never throw.
 *
 * Clip ids are <V|A><track>@<startTicks>#<nodeId>: the track, the timeline start and the source
 * project item. A TrackItem's own nodeId changes whenever it is laid again (measured 2026-10-14),
 * so it can't name a clip.
 */

var GCUT_STALE = "The timeline changed since you read it; call get_sequence again.";

/** A clip's id (see the header). */
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
function gcutToolGetSequence(argsJson) {
    try {
        var args = gcutParse(argsJson) || {};
        var seq = gcutSequence(), clock = gcutClock(seq), tracks = gcutTracks(seq), t, i;
        var fromT = typeof args.fromS === "number" ? args.fromS * GCUT_TICKS : null;
        var toT = typeof args.toS === "number" ? args.toS * GCUT_TICKS : null;
        var out = { sequenceId: gcutSeqId(seq), name: String(seq.name || ""), fps: Math.round(clock.fps * 1000) / 1000,
                    durationS: gcutSeqEndT(seq) / GCUT_TICKS, tracks: [], clips: [], markers: [], selection: [] };
        for (t = 0; t < tracks.length; t++) {
            var tr = tracks[t], kind = tr.audio ? "audio" : "video";
            out.tracks.push({ kind: kind, index: tr.index + 1, name: String(tr.track.name || ""),
                              muted: typeof tr.track.isMuted === "function" ? !!tr.track.isMuted() : false });
            var items = gcutItems(tr.track);
            for (i = 0; i < items.length; i++) {
                var it = items[i], s = gcutT(it.start), e = gcutT(it.end);
                if ((fromT !== null && e <= fromT) || (toT !== null && s >= toT)) continue;
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
 * with no markers is refused as incomplete.
 */
function gcutUndoMarkers(seq, record, clock) {
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
    var items = [], pis = {}, i, x;
    for (i = 0; i < record.items.length; i++) {
        x = record.items[i];
        var pi = pis.hasOwnProperty("n" + x.node) ? pis["n" + x.node] : (pis["n" + x.node] = gcutProjectItemByNode(x.node));
        if (!pi) throw new Error(x.label + "'s source isn't in the project any more, so the cut can't be undone. Use Premiere's Undo instead.");
        items.push({ kind: x.kind, trackIndex: x.trackIndex, label: x.label, pi: pi, node: x.node, startT: x.startT, endT: x.endT,
                     inS: x.inS, outS: x.outS, srcFrameS: x.srcFrameS, loose: x.loose, mediaFrameS: x.mediaFrameS, av: x.av });
    }
    return { sequenceId: record.sequenceId, startT: record.startT, endT: record.endT, cutsT: record.cutsT,
             rebuiltEndT: record.rebuiltEndT, items: items, others: record.others };
}

/**
 * args: { sequenceId, clipIds, ranges: [{fromS, toS}], acceptEffectLoss? } — cut these sequence-time ranges out of the
 * chosen clips (ids from get_sequence), with Apply's engine and guarantees: the clips are found and
 * checked as Apply finds its recorded ones (locked tracks, speed, loose sources, audio from video
 * files), Apply's pre-checks refuse what the rebuild would overwrite, and the cut is all or nothing.
 * The ranges are clipped to the chosen clips' span [earliest start, latest end]. The rebuild drops the
 * clips' effects, so, as Apply makes the user acknowledge them, any on a chosen clip refuse the cut
 * unless acceptEffectLoss is true. Returns { ok,
 * cutCount, clipCount, removedS, crossfades, warning?, undo } (undo: gcutCutRecord). Never touches
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
        var r = gcutCutCore(seq, clock, found, cutsT, rec);
        if (!r.ok) throw new Error(gcutCutFailed(seq, clock, r, others).message);
        return gcutOk({ ok: true, cutCount: r.appliedCount, clipCount: r.clipCount, removedS: r.trailingGapS,
                        crossfades: r.crossfades, warning: r.warning, undo: gcutCutRecord(rec) });
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
 * A refusal changes nothing; a re-lay that fails puts the cut version back.
 */
function gcutUndoCuts(seq, record, clock) {
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

/**
 * args: { record } — the `undo` record an act tool returned, as it returned it (pure data, so it
 * survives a panel reload). Returns { ok: true }, or { ok: true, alreadyUndone: true } when nothing of
 * that change is left (Premiere's own Undo took it back); refuses, changing nothing, when what that
 * change made was changed by hand since.
 */
function gcutToolUndo(argsJson) {
    try {
        var args = gcutParse(argsJson) || {}, record = args.record;
        if (!record || !record.kind) throw new Error("There's nothing to undo.");
        var seq = gcutSequence(), clock = gcutClock(seq);
        if (String(record.sequenceId) !== gcutSeqId(seq)) {
            throw new Error("A different sequence is open than the one this change was made on. Open that sequence first.");
        }
        if (record.kind === "markers") return gcutOk(gcutUndoMarkers(seq, record, clock));
        if (record.kind === "cuts") return gcutOk(gcutUndoCuts(seq, record, clock));
        throw new Error("Genius Cut can't undo a change of kind " + record.kind + ".");
    } catch (e) {
        return gcutFail(e);
    }
}
