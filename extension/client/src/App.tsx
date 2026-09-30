import { useState } from "react";
import { runtime } from "./api/runtime";
import type { ClipInfo, TrimResponse } from "./api/types";
import { useBackend } from "./hooks/useBackend";
import { CutTab } from "./components/CutTab";
import { StyleLibrary, type LastTrim } from "./components/StyleLibrary";

const VERSION = "0.1.0";

function BackendStatus({ state, onRetry }: { state: ReturnType<typeof useBackend>["state"]; onRetry: () => void }) {
  if (state.kind === "ready") return null;
  const text =
    state.kind === "checking" ? "Connecting to the Genius Cut backend…"
    : state.kind === "starting" ? "Loading the speech model. The first start downloads about 3 GB."
    : state.message;
  return (
    <div className="sec">
      <div className="status">
        <span className={`pip ${state.kind === "failed" ? "bad" : "busy"}`} />
        <span>{text}</span>
      </div>
      {state.kind === "failed" && (
        <div className="prompt" style={{ marginTop: 8 }}>
          <span className="muted" style={{ fontSize: 10.5 }}>Log: {runtime.logPath()}</span>
          <span className="spacer" />
          <button className="btn btn-g" onClick={onRetry}>Retry</button>
        </div>
      )}
    </div>
  );
}

export function App() {
  const { state, retry } = useBackend();
  const [lastTrim, setLastTrim] = useState<LastTrim | null>(null);
  const ready = state.kind === "ready";
  const health = state.kind === "ready" || state.kind === "starting" ? state.health : null;

  return (
    <div className="panel">
      <header className="hd">
        <span className="mark">GC</span>
        <span className="wm">Genius<span>Cut</span></span>
        <span className="ver">{VERSION}</span>
      </header>

      {runtime.isSample && (
        <div className="banner"><b>Sample data.</b> Running outside Premiere: the clip, cuts and results are illustrative.</div>
      )}

      <div className="tabs" role="tablist">
        <button className="tab" role="tab" aria-selected="true">Cut</button>
        <button className="tab" role="tab" aria-selected="false" disabled>Generate</button>
        <button className="tab" role="tab" aria-selected="false" disabled>Sound</button>
      </div>

      <BackendStatus state={state} onRetry={retry} />

      <CutTab health={health} ready={ready}
        onTrimmed={(clip: ClipInfo, res: TrimResponse, checked: boolean[]) => setLastTrim({ clip, res, checked })} />

      <StyleLibrary ready={ready} lastTrim={lastTrim} />
    </div>
  );
}
