import type { ClipInfo, TrimResponse } from "../api/types";
import { reviewSummary } from "../lib/review";
import { formatDuration, formatTimecode } from "../lib/timecode";

/** The coral hand-drawn ellipse (brand "Scribble Markup"), used once: on the reclaimed figure. */
function Scribble() {
  return (
    <svg viewBox="0 0 100 50" preserveAspectRatio="none" aria-hidden="true">
      <path d="M8 27 C 6 10, 60 3, 88 12 C 102 17, 98 38, 64 44 C 32 49, 4 42, 7 25 C 9 14, 40 8, 70 9"
        fill="none" stroke="#FF7A51" strokeWidth="1.6" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

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

  if (res.cuts.length === 0) {
    return (
      <div className="sec">
        <div className="note"><b>Nothing to cut.</b> This clip already reads cleanly in your style.</div>
      </div>
    );
  }

  return (
    <>
      <div className="sec">
        <div className="summary">
          <span className="big">{s.reclaimedS.toFixed(1)}s<Scribble /></span>
          <span className="cap">reclaimed from <b>{s.count} {s.count === 1 ? "cut" : "cuts"}</b><br />
            across {formatDuration(duration)} of footage</span>
        </div>
        <div className="durline">
          <span>{formatDuration(duration)}</span><span className="muted">→</span>
          <span className="to">{formatDuration(s.resultS)}</span>
          {unticked > 0 && <span style={{ marginLeft: "auto" }}>{unticked} kept in</span>}
        </div>
      </div>

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
      <div className="actions">
        <button className="btn btn-g" onClick={onDiscard} disabled={busy}>Discard</button>
        <button className="btn btn-p" onClick={onApply} disabled={busy || s.count === 0 || s.keepsNothing}>Apply to timeline</button>
      </div>
    </>
  );
}
