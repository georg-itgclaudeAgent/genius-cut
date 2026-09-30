import { useState } from "react";
import { runtime } from "../api/runtime";
import { HostUnavailable, type ApplyResult } from "../api/host";
import type { ClipInfo, Health, TrimResponse } from "../api/types";
import { parseClipName } from "../lib/prompt";
import { keptSpansSource } from "../lib/review";
import { formatDuration } from "../lib/timecode";
import { CutReview } from "./CutReview";

type Phase =
  | { k: "idle" }
  | { k: "finding" }
  | { k: "analysing"; clip: ClipInfo }
  | { k: "review"; clip: ClipInfo; res: TrimResponse; checked: boolean[] }
  | { k: "applying"; clip: ClipInfo; res: TrimResponse; checked: boolean[] }
  | { k: "applied"; clip: ClipInfo; res: TrimResponse; result: ApplyResult; gapClosed: boolean }
  | { k: "error"; message: string; clip?: ClipInfo };

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
  const clip = "clip" in phase ? phase.clip : undefined;

  async function analyse() {
    setPhase({ k: "finding" });
    let found: ClipInfo;
    try {
      found = await runtime.host.findClip(parseClipName(instruction));
      if (!found.found) throw new Error("No matching clip on the active sequence. Select one, or type its name.");
    } catch (e) {
      setPhase({ k: "error", message: errMsg(e) });
      return;
    }
    setPhase({ k: "analysing", clip: found });
    try {
      const res = await runtime.backend.trim({
        media_path: found.mediaPath, in_s: found.inS, out_s: found.outS, clip_start_s: found.startS, prompt: instruction,
      });
      const checked = res.cuts.map(() => true);
      setPhase({ k: "review", clip: found, res, checked });
      onTrimmed(found, res, checked);
    } catch (e) {
      setPhase({ k: "error", message: errMsg(e), clip: found });
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
    setPhase({ k: "applying", clip: c, res, checked });
    try {
      const result = await runtime.host.applyCuts(c, keptSpansSource(res.cuts, checked, { in_s: c.inS, out_s: c.outS }));
      if (!result.ok) {
        setPhase({ k: "error", clip: c, message: result.message ||
          `The rebuilt clip is ${result.actualDuration.toFixed(2)} s, expected ${result.expectedDuration.toFixed(2)} s. ` +
          "Nothing was hidden: check the timeline, or use Restore original." });
        return;
      }
      setPhase({ k: "applied", clip: c, res, result, gapClosed: false });
    } catch (e) {
      setPhase({ k: "error", clip: c, message: errMsg(e) });
    }
  }

  async function closeGap() {
    if (phase.k !== "applied") return;
    try { await runtime.host.closeGap(phase.clip); setPhase({ ...phase, gapClosed: true }); }
    catch (e) { setPhase({ k: "error", clip: phase.clip, message: errMsg(e) }); }
  }

  async function restore() {
    if (phase.k !== "applied") return;
    try { await runtime.host.restoreOriginal(phase.clip); setPhase({ k: "idle" }); }
    catch (e) { setPhase({ k: "error", clip: phase.clip, message: errMsg(e) }); }
  }

  const working = phase.k === "finding" || phase.k === "analysing";

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
          <button className="btn btn-p" type="submit" disabled={!ready || working || phase.k === "applying"}>Analyse</button>
        </form>
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
          <div className={`note ${phase.message.includes("Phase C") ? "" : "bad"}`}>
            {phase.message}
            <div className="actions-row"><button className="btn btn-g" onClick={() => setPhase({ k: "idle" })}>Dismiss</button></div>
          </div>
        </div>
      )}

      {(phase.k === "review" || phase.k === "applying") && (
        <CutReview clip={phase.clip} res={phase.res} checked={phase.checked} busy={phase.k === "applying"}
          onToggle={toggle} onToggleAll={toggleAll} onApply={apply} onDiscard={() => setPhase({ k: "idle" })} />
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
                {!phase.gapClosed && <div className="actions-row"><button className="btn btn-g" onClick={closeGap}>Close gap</button></div>}
              </div>
            </div>
          )}
          <div className="actions">
            <button className="btn btn-g" onClick={restore}>Restore original</button>
            <button className="btn btn-p" onClick={() => setPhase({ k: "idle" })}>Done</button>
          </div>
        </>
      )}
    </>
  );
}

export { HostUnavailable };
