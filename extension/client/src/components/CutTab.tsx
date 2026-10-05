import { useEffect, useRef, useState } from "react";
import { runtime } from "../api/runtime";
import { HostUnavailable, type ApplyResult } from "../api/host";
import type { AiStatus, ClipInfo, Health, TrimResponse } from "../api/types";
import { afterTrimRefresh, watchAiStatus } from "../lib/aiStatus";
import { clipProblem } from "../lib/clip";
import { budgetEstimate } from "../lib/cost";
import { parseClipName } from "../lib/prompt";
import { keptSpansSource } from "../lib/review";
import { formatDuration } from "../lib/timecode";
import { CostEstimate } from "./Cost";
import { CutReview } from "./CutReview";

type Phase =
  | { k: "idle" }
  | { k: "finding" }
  | { k: "analysing"; clip: ClipInfo }
  | { k: "review"; clip: ClipInfo; res: TrimResponse; checked: boolean[] }
  | { k: "applying"; clip: ClipInfo; res: TrimResponse; checked: boolean[] }
  | { k: "applied"; clip: ClipInfo; res: TrimResponse; result: ApplyResult; gapClosed: boolean; busy: boolean }
  | { k: "error"; message: string; clip?: ClipInfo; notYet?: boolean; restorable?: boolean };

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const errorPhase = (e: unknown, clip?: ClipInfo, restorable = false): Phase =>
  ({ k: "error", message: errMsg(e), clip, notYet: e instanceof HostUnavailable, restorable });

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
  onTrimmed: (clip: ClipInfo, res: TrimResponse, checked: boolean[]) => void;
}) {
  const [instruction, setInstruction] = useState("trim the selected clip");
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
  const clip = "clip" in phase ? phase.clip : undefined;

  async function analyse() {
    go({ k: "finding" });
    let found: ClipInfo;
    try {
      found = await runtime.host.findClip(parseClipName(instruction));
      const problem = clipProblem(found);
      if (problem) throw new Error(problem);
    } catch (e) {
      go(errorPhase(e));
      return;
    }
    setPhase({ k: "analysing", clip: found });
    try {
      // The refresh isn't awaited: the review shouldn't wait on /health.
      const res = await afterTrimRefresh(() => runtime.backend.trim({
        media_path: found.mediaPath, in_s: found.inS, out_s: found.outS, clip_start_s: found.startS, prompt: instruction,
      }), async () => { aiWatch.current?.refresh(); });
      const checked = res.cuts.map(() => true);
      setPhase({ k: "review", clip: found, res, checked });
      onTrimmed(found, res, checked);
    } catch (e) {
      go(errorPhase(e, found));
    }
  }

  function toggle(i: number) {
    if (phase.k !== "review") return;
    const checked = phase.checked.map((v, j) => (j === i ? !v : v));
    setPhase({ ...phase, checked });
    onTrimmed(phase.clip, phase.res, checked);
  }

  function toggleAll() {
    if (phase.k !== "review") return;
    const all = phase.checked.every(Boolean);
    const checked = phase.checked.map(() => !all);
    setPhase({ ...phase, checked });
    onTrimmed(phase.clip, phase.res, checked);
  }

  async function apply() {
    if (phase.k !== "review") return;
    const { clip: c, res, checked } = phase;
    go({ k: "applying", clip: c, res, checked });
    try {
      const result = await runtime.host.applyCuts(c, keptSpansSource(res.cuts, checked, { in_s: c.inS, out_s: c.outS }));
      if (!result.ok) {
        go({ k: "error", clip: c, restorable: !result.rolledBack, message: result.message ||
          `The rebuilt clip is ${result.actualDuration.toFixed(2)} s, expected ${result.expectedDuration.toFixed(2)} s. ` +
          "Nothing was hidden: check the timeline, or restore the original." });
        return;
      }
      go({ k: "applied", clip: c, res, result, gapClosed: false, busy: false });
    } catch (e) {
      // A throw mid-rebuild can leave the timeline half-changed, so offer the restore.
      go(errorPhase(e, c, !(e instanceof HostUnavailable)));
    }
  }

  async function closeGap() {
    if (phase.k !== "applied" || phase.busy) return;
    const start = phase, mine = ++epoch.current;
    setPhase({ ...start, busy: true });
    try {
      await runtime.host.closeGap(start.clip);
      if (epoch.current === mine) setPhase({ ...start, gapClosed: true, busy: false });
    } catch (e) {
      if (epoch.current === mine) go(errorPhase(e, start.clip, true));
    }
  }

  async function restore(c: ClipInfo) {
    const mine = ++epoch.current;
    if (phase.k === "applied") setPhase({ ...phase, busy: true });
    try {
      await runtime.host.restoreOriginal(c);
      if (epoch.current === mine) go({ k: "idle" });
    } catch (e) {
      if (epoch.current === mine) go(errorPhase(e, c, true));
    }
  }

  const working = phase.k === "finding" || phase.k === "analysing";
  const ai = health?.ai ? freshAi ?? health.ai : null;
  const monthUsd = ai?.month_usd ?? null;
  const clipS = clip ? clip.outS - clip.inS : null;
  const overLimit = ai ? budgetEstimate(ai, clipS, monthUsd).over : false;

  return (
    <>
      <div className="sec">
        <div className="sec-hd">
          <span className="lbl">Target clip</span><span className="spacer" />
          {clip?.selectedUsed && <span className="lbl" style={{ color: "var(--blue)" }}>selected</span>}
          {clip && clip.matchCount > 1 && !clip.selectedUsed && <span className="lbl" style={{ color: "var(--coral)" }}>first of {clip.matchCount}</span>}
        </div>
        {clip ? (
          <div className="clip">
            <div className="thumb" />
            <div style={{ minWidth: 0 }}>
              <div className="clip-name">{clip.name}</div>
              <div className="clip-meta">V{clip.trackIndex + 1} · {formatDuration(clip.outS - clip.inS)} · {clip.fps}</div>
            </div>
          </div>
        ) : <div className="muted">Select a clip in the timeline, or name it below.</div>}
      </div>

      <div className="sec">
        <div className="sec-hd"><span className="lbl">Instruction</span></div>
        <form className="prompt" onSubmit={(e) => { e.preventDefault(); analyse(); }}>
          <input value={instruction} onChange={(e) => setInstruction(e.target.value)} aria-label="Instruction" />
          <button className="btn btn-p" type="submit"
            disabled={!ready || working || overLimit || phase.k === "applying" || phase.k === "applied"}
            title={overLimit ? "Monthly AI limit reached" : undefined}>Analyse</button>
        </form>
        {ai && <CostEstimate ai={ai} clipS={clipS} monthUsd={monthUsd} />}
      </div>

      {working && (
        <div className="sec">
          <div className="stages">
            <Stage state={phase.k === "finding" ? "run" : "done"} label="Find the clip in the timeline" />
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
              {phase.restorable && phase.clip && (
                <button className="btn btn-g" onClick={() => restore(phase.clip!)}>Restore original</button>
              )}
              <button className="btn btn-g" onClick={() => go({ k: "idle" })}>Dismiss</button>
            </div>
          </div>
        </div>
      )}

      {(phase.k === "review" || phase.k === "applying") && (
        <CutReview key={`${phase.clip.trackIndex}@${phase.clip.startTicks}`} clip={phase.clip} res={phase.res} checked={phase.checked} busy={phase.k === "applying"}
          onToggle={toggle} onToggleAll={toggleAll} onApply={apply} onDiscard={() => go({ k: "idle" })} />
      )}

      {phase.k === "applied" && (
        <>
          <div className="sec">
            <div className="verdict"><span className="tick">✓</span><span className="t">Applied and verified</span></div>
            <div className="durline" style={{ marginTop: 0 }}>
              <span>{formatDuration(phase.clip.outS - phase.clip.inS)}</span><span className="muted">→</span>
              <span className="to">{formatDuration(phase.result.actualDuration)}</span>
              <span style={{ marginLeft: "auto", color: "var(--blue)" }}>{phase.result.appliedCount} spans rebuilt</span>
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
            <button className="btn btn-g" onClick={() => restore(phase.clip)} disabled={phase.busy}>Restore original</button>
            <button className="btn btn-p" onClick={() => go({ k: "idle" })} disabled={phase.busy}>Done</button>
          </div>
        </>
      )}
    </>
  );
}

export { HostUnavailable };
