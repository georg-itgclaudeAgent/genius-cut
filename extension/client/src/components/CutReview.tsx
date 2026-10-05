import { useState } from "react";
import type { ClipInfo, TrimResponse } from "../api/types";
import { reviewSummary } from "../lib/review";
import { RunCostLine } from "./Cost";
import { formatDuration, formatTimecode } from "../lib/timecode";

interface Props {
  clip: ClipInfo;
  res: TrimResponse;
  checked: boolean[];
  onToggle: (i: number) => void;
  onToggleAll: () => void;
  onApply: () => void;
  onDiscard: () => void;
  busy: boolean;
}

export function CutReview({ clip, res, checked, onToggle, onToggleAll, onApply, onDiscard, busy }: Props) {
  const duration = clip.outS - clip.inS;
  const s = reviewSummary(res.cuts, checked, duration);
  const unticked = checked.length - s.count;
  const effects = clip.effects ?? [];
  const [ack, setAck] = useState(false);

  if (res.cuts.length === 0) {
    return (
      <>
        <div className="sec">
          <div className="note"><b>Nothing to cut.</b> This clip already reads cleanly in your style.</div>
        </div>
        {res.cost && <RunCostLine cost={res.cost} />}
      </>
    );
  }

  return (
    <>
      <div className="sec">
        <div className="summary">
          <span className="big">{s.reclaimedS.toFixed(1)}s</span>
          <span className="cap">reclaimed from <b>{s.count} {s.count === 1 ? "cut" : "cuts"}</b><br />
            across {formatDuration(duration)} of footage</span>
        </div>
        <div className="durline">
          <span>{formatDuration(duration)}</span><span className="muted">→</span>
          <span className="to">{formatDuration(s.resultS)}</span>
          {unticked > 0 && <span style={{ marginLeft: "auto" }}>{unticked} kept in</span>}
        </div>
      </div>

      {res.cost && <RunCostLine cost={res.cost} />}
      {res.warning && <div className="sec"><div className="note warn">{res.warning}</div></div>}
      {s.keepsNothing && (
        <div className="sec"><div className="note bad"><b>That would remove the whole clip.</b> Untick at least one cut to apply.</div></div>
      )}

      <div className="sec" style={{ paddingBottom: 8 }}>
        <div className="sec-hd" style={{ marginBottom: 0 }}>
          <span className="lbl">Proposed removals</span><span className="spacer" />
          <button className="btn-link" onClick={onToggleAll}>{s.count === checked.length ? "Untick all" : "Tick all"}</button>
        </div>
      </div>
      <div className="cuts">
        {res.cuts.map((c, i) => (
          <label key={i} className={`cut${checked[i] ? "" : " off"}`}>
            <input type="checkbox" checked={checked[i]} onChange={() => onToggle(i)}
              aria-label={`Remove "${c.text}" at ${formatTimecode(c.start_seq_s, clip.fps)}`} />
            <span>
              <span className="row1">
                <span className="tc">{formatTimecode(c.start_seq_s, clip.fps)}</span>
                <span className="why">{c.reason}</span>
                <span className="len">−{(c.end - c.start).toFixed(1)}s</span>
              </span>
              <span className="cut-txt" style={{ display: "block" }}>{c.text}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="sec">
        <div className={`note${effects.length ? " warn" : ""}`}>
          Genius Cut rebuilds this clip from the source, so effects, grades, keyframes and audio gain on it
          aren't kept. Trim first, then grade.
          {effects.length > 0 && (
            <label className="ack">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>Remove <b>{effects.join(", ")}</b> from this clip and apply</span>
            </label>
          )}
        </div>
      </div>
      <div className="actions">
        <button className="btn btn-g" onClick={onDiscard} disabled={busy}>Discard</button>
        <button className="btn btn-p" onClick={onApply}
          disabled={busy || s.count === 0 || s.keepsNothing || (effects.length > 0 && !ack)}>Apply to timeline</button>
      </div>
    </>
  );
}
