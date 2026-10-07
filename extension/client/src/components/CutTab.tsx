import { useEffect, useRef, useState } from "react";
import { runtime } from "../api/runtime";
import { HostUnavailable, type ApplyResult } from "../api/host";
import type { AiStatus, Health, Snapshot, SnapshotItem, TrimResponse } from "../api/types";
import { afterTrimRefresh, watchAiStatus } from "../lib/aiStatus";
import { budgetEstimate } from "../lib/cost";
import { parseClipName, submitsPrompt } from "../lib/prompt";
import { keptSpans } from "../lib/review";
import { audioChoice, recalledAudio, rememberAudio, snapshotSummary, trimRequestFor } from "../lib/snapshot";
import { formatDuration } from "../lib/timecode";
import { CostEstimate } from "./Cost";
import { AudioPicker } from "./AudioPicker";
import { CutReview } from "./CutReview";

type Phase =
  | { k: "idle" }
  | { k: "finding" }
  | { k: "choosing"; snap: Snapshot; preselect: string | null }
  | { k: "analysing"; snap: Snapshot }
  | { k: "review"; snap: Snapshot; res: TrimResponse; checked: boolean[] }
  | { k: "applying"; snap: Snapshot; res: TrimResponse; checked: boolean[] }
  | { k: "applied"; snap: Snapshot; res: TrimResponse; result: ApplyResult; gapClosed: boolean; busy: boolean }
  | { k: "error"; message: string; snap?: Snapshot; notYet?: boolean; restorable?: boolean };

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const errorPhase = (e: unknown, snap?: Snapshot, restorable = false): Phase =>
  ({ k: "error", message: errMsg(e), snap, notYet: e instanceof HostUnavailable, restorable });

/**
 * After a failed Apply, offer "Restore original" only when the host reports a mid-rebuild failure
 * it couldn't roll back. A thrown refusal (changed since Analyse, locked, different sequence...)
 * changed nothing, and Restore there could undo an earlier edit stashed at the same start.
 */
export function offersRestore(outcome: unknown): boolean {
  if (outcome instanceof Error || !outcome || typeof outcome !== "object") return false;
  const r = outcome as ApplyResult;
  return r.ok === false && r.rolledBack === false;
}

function Telemetry({ device }: { device: string }) {
  const gpu = device === "cuda";
  return (
    <div className="tele">
      <span className={`pip ${gpu ? "ok" : "busy"}`} />
      <span className="txt">On this machine</span>
      <span className="det">{gpu ? "GPU · large-v3 · fp16" : "CPU · large-v3 · int8 (slower)"}</span>
    </div>
  );
}

function Stage({ state, label }: { state: "wait" | "run" | "done"; label: string }) {
  return <div className={`stg ${state}`}><span className="dot">{state === "done" ? "✓" : ""}</span><span>{label}</span></div>;
}

export function CutTab({ health, ready, onTrimmed }: {
  health: Health | null;
  ready: boolean;
  onTrimmed: (snap: Snapshot, res: TrimResponse, checked: boolean[]) => void;
}) {
  const [instruction, setInstruction] = useState("trim the selected clip");
  const formRef = useRef<HTMLFormElement>(null);
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  // /health is read once at connect; this re-reads its ai block after every trim attempt
  // and on focus/visibility, so the month and the limit (the source of truth) stay current.
  const [freshAi, setFreshAi] = useState<AiStatus | null>(null);
  const aiWatch = useRef<ReturnType<typeof watchAiStatus> | null>(null);
  useEffect(() => {
    const w = watchAiStatus({ fetchHealth: runtime.backend.health, onAi: setFreshAi, win: window, doc: document });
    aiWatch.current = w;
    return () => { w.stop(); aiWatch.current = null; };
  }, []);
  // Bumped on every phase change we start; a host call that returns after the user
  // has moved on (Done, Analyse again) must not resurrect the old phase.
  const epoch = useRef(0);
  const go = (p: Phase) => { epoch.current++; setPhase(p); };
  const snap = "snap" in phase ? phase.snap : undefined;

  async function analyse() {
    const mine = ++epoch.current;
    setPhase({ k: "finding" });
    try {
      const found = await runtime.host.snapshotSelection(parseClipName(instruction));
      if (epoch.current !== mine) return;
      if (!found.found) return go({ k: "error", message: found.message });
      // Problems (no audio, speed-changed, out of sync...) stop here, before any audio is chosen.
      if (found.problems.length) return go({ k: "error", message: found.problems.join(" ") });
      const choice = audioChoice(found, recalledAudio(found.sequenceId));
      if (choice.kind === "ask") return go({ k: "choosing", snap: found, preselect: choice.preselect });
      await run(found, choice.sources);
    } catch (e) {
      if (epoch.current === mine) go(errorPhase(e));
    }
  }

  // The snapshot lives in the phase, so selection changes in Premiere during analysis never reach Apply.
  async function run(found: Snapshot, sources: SnapshotItem[]) {
    go({ k: "analysing", snap: found });
    const mine = epoch.current;
    try {
      // The refresh isn't awaited: the review shouldn't wait on /health.
      const res = await afterTrimRefresh(() => runtime.backend.trim(trimRequestFor(found, sources, instruction)),
        async () => { aiWatch.current?.refresh(); });
      if (epoch.current !== mine) return;
      const checked = res.cuts.map(() => true);
      setPhase({ k: "review", snap: found, res, checked });
      onTrimmed(found, res, checked);
    } catch (e) {
      if (epoch.current === mine) go(errorPhase(e, found));
    }
  }

  function toggle(i: number) {
    if (phase.k !== "review") return;
    const checked = phase.checked.map((v, j) => (j === i ? !v : v));
    setPhase({ ...phase, checked });
    onTrimmed(phase.snap, phase.res, checked);
  }

  function toggleAll() {
    if (phase.k !== "review") return;
    const all = phase.checked.every(Boolean);
    const checked = phase.checked.map(() => !all);
    setPhase({ ...phase, checked });
    onTrimmed(phase.snap, phase.res, checked);
  }

  async function apply() {
    if (phase.k !== "review") return;
    const { snap: c, res, checked } = phase;
    go({ k: "applying", snap: c, res, checked });
    try {
      const result = await runtime.host.applyCuts(c, keptSpans(res.cuts, checked, c.durationS));
      if (!result.ok) {
        go({ k: "error", snap: c, restorable: offersRestore(result), message: result.message ||
          `The rebuilt clip is ${result.actualDuration.toFixed(2)} s, expected ${result.expectedDuration.toFixed(2)} s. ` +
          "Nothing was hidden: check the timeline, or restore the original." });
        return;
      }
      go({ k: "applied", snap: c, res, result, gapClosed: false, busy: false });
    } catch (e) {
      // The host turns every failure after the first change into ok:false, so a throw is a
      // refusal (or a missing host) that changed nothing: no restore.
      go(errorPhase(e, c, offersRestore(e)));
    }
  }

  async function closeGap() {
    if (phase.k !== "applied" || phase.busy) return;
    const start = phase, mine = ++epoch.current;
    setPhase({ ...start, busy: true });
    try {
      await runtime.host.closeGap(start.snap);
      if (epoch.current === mine) setPhase({ ...start, gapClosed: true, busy: false });
    } catch (e) {
      if (epoch.current === mine) go(errorPhase(e, start.snap, true));
    }
  }

  async function restore(c: Snapshot) {
    const mine = ++epoch.current;
    if (phase.k === "applied") setPhase({ ...phase, busy: true });
    try {
      await runtime.host.restore(c);
      if (epoch.current === mine) go({ k: "idle" });
    } catch (e) {
      if (epoch.current === mine) go(errorPhase(e, c, true));
    }
  }

  const working = phase.k === "finding" || phase.k === "analysing";
  const ai = health?.ai ? freshAi ?? health.ai : null;
  const monthUsd = ai?.month_usd ?? null;
  const clipS = snap ? snap.durationS : null;
  const overLimit = ai ? budgetEstimate(ai, clipS, monthUsd).over : false;
  // One rule for the button and for Enter: submitting from code ignores a disabled button.
  const canAnalyse = ready && !working && !overLimit && phase.k !== "applying" && phase.k !== "applied";

  return (
    <>
      <div className="sec">
        <div className="sec-hd">
          <span className="lbl">Target clip</span><span className="spacer" />
        </div>
        {snap ? (
          <div className="clip">
            <div className="thumb" />
            <div style={{ minWidth: 0 }}>
              <div className="clip-name">{snapshotSummary(snap)}</div>
              {snap.video.length > 1 && <div className="clip-meta">recorded at Analyse</div>}
            </div>
          </div>
        ) : <div className="muted">Select a clip in the timeline, or name it below.</div>}
      </div>

      <div className="sec">
        <div className="sec-hd"><span className="lbl">Instruction</span></div>
        <form className="prompt" ref={formRef} onSubmit={(e) => { e.preventDefault(); if (canAnalyse) analyse(); }}>
          <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} aria-label="Instruction" rows={3}
            onKeyDown={(e) => {
              if (submitsPrompt({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing })) {
                e.preventDefault();
                formRef.current?.requestSubmit();
              }
            }} />
          <button className="btn btn-p" type="submit"
            disabled={!canAnalyse}
            title={overLimit ? "Monthly AI limit reached" : undefined}>Analyse</button>
        </form>
        {ai && <CostEstimate ai={ai} clipS={clipS} monthUsd={monthUsd} />}
      </div>

      <div className="result" aria-label="Result">
        {phase.k === "idle" && <div className="result-empty">Result</div>}
        {working && (
          <div className="sec">
            <div className="stages">
              <Stage state={phase.k === "finding" ? "run" : "done"} label="Find the clips in the timeline" />
              <Stage state={phase.k === "analysing" ? "run" : "wait"} label="Transcribe on this machine, then propose cuts" />
            </div>
            {health && <Telemetry device={health.stt_device} />}
          </div>
        )}

        {phase.k === "error" && (
          <div className="sec">
            <div className={`note ${phase.notYet ? "" : "bad"}`}>
              {phase.message}
              <div className="actions-row">
                {phase.restorable && phase.snap && (
                  <button className="btn btn-g" onClick={() => restore(phase.snap!)}>Restore original</button>
                )}
                <button className="btn btn-g" onClick={() => go({ k: "idle" })}>Dismiss</button>
              </div>
            </div>
          </div>
        )}

        {phase.k === "choosing" && (
          <AudioPicker snap={phase.snap} preselect={phase.preselect} onCancel={() => go({ k: "idle" })}
            onPick={(key, sources) => { rememberAudio(phase.snap.sequenceId, key); run(phase.snap, sources); }} />
        )}

        {(phase.k === "review" || phase.k === "applying") && (
          <CutReview key={`${phase.snap.sequenceId}@${phase.snap.startTicks}`} snap={phase.snap} res={phase.res} checked={phase.checked} busy={phase.k === "applying"}
            onToggle={toggle} onToggleAll={toggleAll} onApply={apply} onDiscard={() => go({ k: "idle" })} />
        )}

        {phase.k === "applied" && (
          <>
            <div className="sec">
              <div className="verdict"><span className="tick">✓</span><span className="t">Applied and verified</span></div>
              <div className="durline" style={{ marginTop: 0 }}>
                <span>{formatDuration(phase.snap.durationS)}</span><span className="muted">→</span>
                <span className="to">{formatDuration(phase.result.actualDuration)}</span>
                <span style={{ marginLeft: "auto", color: "var(--blue)" }}>{phase.result.appliedCount} spans rebuilt in {phase.result.clipCount} {phase.result.clipCount === 1 ? "clip" : "clips"}</span>
              </div>
            </div>
            {phase.result.trailingGapS > 0.01 && (
              <div className="sec">
                <div className="note">
                  {phase.gapClosed ? <b>Gap closed.</b> : <><b>{phase.result.trailingGapS.toFixed(1)}s of reclaimed time</b> is sitting
                    as a gap after the clip, so nothing on other tracks moved.</>}
                  {!phase.gapClosed && <div className="actions-row"><button className="btn btn-g" onClick={closeGap} disabled={phase.busy}>Close gap</button></div>}
                </div>
              </div>
            )}
            <div className="actions">
              <button className="btn btn-g" onClick={() => restore(phase.snap)} disabled={phase.busy}>Restore original</button>
              <button className="btn btn-p" onClick={() => go({ k: "idle" })} disabled={phase.busy}>Done</button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

export { HostUnavailable };
