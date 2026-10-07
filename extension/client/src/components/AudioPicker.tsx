import type { Snapshot, SnapshotItem } from "../api/types";
import { audioKey } from "../lib/snapshot";

export function AudioPicker({ snap, onPick, onCancel }: {
  snap: Snapshot; onPick: (key: string, sources: SnapshotItem[]) => void; onCancel: () => void;
}) {
  return (
    <div className="sec">
      <div className="lbl">Which audio should Genius Cut listen to?</div>
      <div className="picker">
        {snap.audio.map((a) => (
          <button key={audioKey(a)} className="btn btn-g" onClick={() => onPick(audioKey(a), [a])}>
            {a.label} · {a.name}
          </button>
        ))}
        <button className="btn btn-g" onClick={() => onPick("mix", snap.audio)}>Mix all (separate mics)</button>
      </div>
      <p className="muted" style={{ fontSize: 10.5 }}>Every audio clip is still cut either way. This only picks what Genius Cut transcribes.</p>
      <button className="btn btn-g" onClick={onCancel}>Cancel</button>
    </div>
  );
}
