/** The instruction run's screens in the Result area: Claude's plan (Go / Cancel) and the result (Undo). */
import type { Outcome } from "../agent/run";
import type { RunCost } from "../api/types";
import { RunCostLine } from "./Cost";

export function PlanView({ text, cost, onGo, onCancel }: { text: string; cost: RunCost | null; onGo: () => void; onCancel: () => void }) {
  return (
    <>
      <div className="sec">
        <div className="sec-hd"><span className="lbl">Claude's plan</span></div>
        <pre className="plan-text">{text}</pre>
        <div className="actions-row">
          <button className="btn btn-p" onClick={onGo}>Go</button>
          <button className="btn btn-g" onClick={onCancel}>Cancel</button>
        </div>
      </div>
      {cost && <RunCostLine cost={cost} />}
    </>
  );
}

const HEAD: Record<string, string> = { done: "Done", stopped: "Stopped", cancelled: "Cancelled", lost: "Run lost", error: "Stopped" };

export function RunResult({ out, undoing, undoMsg, undoBad, onUndo, onDone }: {
  out: Extract<Outcome, { k: "finished" }>; undoing: boolean; undoMsg: string | null; undoBad: boolean; onUndo: () => void; onDone: () => void;
}) {
  const bad = out.state === "lost" || out.state === "error";
  return (
    <>
      <div className="sec">
        <div className="verdict">
          <span className={`tick${out.state === "done" ? "" : " off"}`}>{out.state === "done" ? "✓" : "•"}</span>
          <span className="t">{HEAD[out.state]}</span>
        </div>
        {out.message && <div className={`note ${bad ? "bad" : "warn"}`}>{out.message}</div>}
        {out.text && <div className="plan-text" style={{ marginTop: 6 }}>{out.text}</div>}
        {out.lines.length > 0 && (
          <div className="act-lines" aria-label="What was done">
            {out.lines.map((l, i) => (
              <div key={i} className={`act-line${l.ok ? "" : " bad"}`}>
                <span className="mk">{l.ok ? "✓" : "✗"}</span><span className="tx">{l.text}</span>
                {l.notInPlan && <span className="why flag">not in the plan</span>}
              </div>
            ))}
          </div>
        )}
        {undoMsg && <div className={`note${undoBad ? " bad" : ""}`} style={{ marginTop: 8 }}>{undoMsg}</div>}
      </div>
      {out.cost && <RunCostLine cost={out.cost} />}
      <div className="actions">
        {out.undo && <button className="btn btn-g" onClick={onUndo} disabled={undoing}>Undo</button>}
        <button className="btn btn-p" onClick={onDone} disabled={undoing}>Done</button>
      </div>
    </>
  );
}
