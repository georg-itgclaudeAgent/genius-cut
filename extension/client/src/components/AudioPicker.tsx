import type { Snapshot, SnapshotItem } from "../api/types";
import { audioKey } from "../lib/snapshot";

/** preselect: the key last used on this sequence, shown as the primary button. */
export function AudioPicker({ snap, preselect, onPick, onCancel }: {
  snap: Snapshot; preselect: string | null; onPick: (key: string, sources: SnapshotItem[]) => void; onCancel: () => void;
}) {
  const option = (key: string, label: string, sources: SnapshotItem[]) => (
    <button key={key} className={`btn ${key === preselect ? "btn-p" : "btn-g"}`} onClick={() => onPick(key, sources)}>
      {label}{key === preselect && " · Last used"}
    </button>
  );
  return (
    <div className="sec">
      <div className="lbl">Which audio should Genius Cut listen to?</div>
      <div className="picker">
        {snap.audio.map((a) => option(audioKey(a), `${a.label} · ${a.name}`, [a]))}
        {option("mix", "Mix all (separate mics)", snap.audio)}
      </div>
      <p className="muted" style={{ fontSize: 10.5 }}>Every audio clip is still cut either way. This only picks what Genius Cut transcribes.</p>
      <button className="btn btn-g" onClick={onCancel}>Cancel</button>
    </div>
  );
}
