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
 * name, startS, endS, inS, source, selected, enabled}], markers: [{id, startS, endS, name, comments,
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
                                 inS: it.inPoint.seconds, source: gcutSource(it), selected: sel, enabled: it.disabled !== true });
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
