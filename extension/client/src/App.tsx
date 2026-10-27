import { useEffect, useState } from "react";
import { dataDir, evalScript, node, openExternal } from "./api/cep";
import { runtime } from "./api/runtime";
import { startAssistant, type Bridge } from "./bridge/server";
import { createTools, type ToolTable } from "./bridge/tools";
import { createTurns } from "./bridge/turns";
import { createAgent, type Agent } from "./agent/run";
import { cutTabBusy } from "./lib/busy";
import type { Snapshot, TrimResponse } from "./api/types";
import { useBackend } from "./hooks/useBackend";
import { startingMessage } from "./lib/lifecycle";
import { setupGate } from "./lib/setup";
import { CutTab } from "./components/CutTab";
import { SetupPage } from "./components/Setup";
import { SettingsPage } from "./components/Settings";
import { StyleLibrary, type LastTrim } from "./components/StyleLibrary";

const VERSION = "0.2.0";

function BackendStatus({ state, onRetry }: { state: ReturnType<typeof useBackend>["state"]; onRetry: () => void }) {
  if (state.kind === "ready") return null;
  const text =
    state.kind === "checking" ? "Connecting to the Genius Cut backend…"
    : state.kind === "starting" ? startingMessage(state.health)
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

/**
 * The Claude assistant's bridge: personal builds only. The literal check lets the bundler drop the
 * bridge from every other build; startAssistant also refuses outside live mode.
 */
function useAssistantBridge(tools: ToolTable, agent: Agent) {
  useEffect(() => {
    if (import.meta.env.VITE_GENIUSCUT_CLAUDE !== "1") return;
    let bridge: Bridge | null = null, gone = false;
    const stop = () => { gone = true; void bridge?.stop(); bridge = null; };
    // The terminal's act calls wait while the Cut tab is busy or a panel instruction run is open.
    startAssistant({ flag: import.meta.env.VITE_GENIUSCUT_CLAUDE, mode: runtime.mode, evalScript, node, dataDir,
      tools, busy: () => cutTabBusy() || agent.isOpen(), panelVersion: VERSION })
      .then((b) => { if (gone) void b?.stop(); else bridge = b; })
      .catch((e) => console.warn("Genius Cut assistant bridge didn't start:", e));
    window.addEventListener("unload", stop);
    return () => { window.removeEventListener("unload", stop); stop(); };
  }, [tools, agent]);
}

/**
 * ONE tool table and ONE undo stack (turns.json) per panel, shared by the instruction runs and the
 * personal bridge: two stacks would overwrite each other's turns.json.
 */
function createKit() {
  const turns = createTurns(runtime.turnStore());
  const tools = createTools({ callHost: runtime.callHost, backend: runtime.backend, turns });
  const agent = createAgent({ api: runtime.backend, tools, turns, callHost: runtime.callHost,
    snapshotTrim: () => runtime.host.snapshotSelection(null) });
  return { tools, agent };
}

export function App() {
  const { state, retry } = useBackend();
  const [kit] = useState(createKit);
  useAssistantBridge(kit.tools, kit.agent);
  const [lastTrim, setLastTrim] = useState<LastTrim | null>(null);
  const ready = state.kind === "ready";
  const health = state.kind === "ready" || state.kind === "starting" ? state.health : null;
  const reachable = health !== null;

  // Live mode opens on Setup until the backend says it's complete (only a passing key test does).
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    if (runtime.mode !== "live" || !reachable || setupComplete !== null || settingsError) return;
    runtime.backend.settings().then((s) => setSetupComplete(s.setup_complete),
      (e) => setSettingsError(e instanceof Error ? e.message : String(e)));
  }, [reachable, setupComplete, settingsError]);
  const gate = setupGate(runtime.mode, setupComplete);

  return (
    <div className="panel">
      <header className="hd">
        <span className="mark">GC</span>
        <span className="wm">Genius<span>Cut</span></span>
        {gate === "open" && reachable && (
          <button className={`gear${settingsOpen ? " on" : ""}`} aria-label="Settings" title="Settings" aria-pressed={settingsOpen}
            onClick={() => setSettingsOpen(!settingsOpen)}>⚙</button>
        )}
        <span className="ver">{VERSION}</span>
      </header>

      {runtime.mode === "preview" && (
        <div className="banner"><b>Preview.</b> This build runs on sample data: trimming your own clips arrives in an update.
          Nothing here changes your timeline.</div>
      )}
      {runtime.mode === "browser" && (
        <div className="banner"><b>Sample data.</b> Running outside Premiere: the clip, cuts and results are illustrative.</div>
      )}

      {gate !== "open" && <BackendStatus state={state} onRetry={retry} />}

      {gate === "checking" && settingsError && (
        <div className="sec">
          <div className="note bad">Couldn't read Genius Cut's settings: {settingsError}
            <div className="actions-row"><button className="btn btn-g" onClick={() => setSettingsError(null)}>Retry</button></div>
          </div>
        </div>
      )}
      {gate === "setup" && reachable && (
        <SetupPage api={runtime.backend} openUrl={openExternal} onDone={() => setSetupComplete(true)} />
      )}
      {gate === "open" && settingsOpen && (
        <SettingsPage api={runtime.backend} keyFromCache={!!health?.ai?.key_from_cache} openUrl={openExternal} onClose={() => setSettingsOpen(false)} />
      )}

      {/* Hidden, not unmounted, while Settings is open: a review in progress stays as it was. */}
      {gate === "open" && (
        <div className="main" hidden={settingsOpen}>
          <div className="tabs" role="tablist">
            <button className="tab" role="tab" aria-selected="true">Cut</button>
            <button className="tab" role="tab" aria-selected="false" disabled>Generate</button>
            <button className="tab" role="tab" aria-selected="false" disabled>Sound</button>
          </div>

          <BackendStatus state={state} onRetry={retry} />

          <CutTab health={health} ready={ready} agent={kit.agent}
            onTrimmed={(snap: Snapshot, res: TrimResponse, checked: boolean[]) => setLastTrim({ snap, res, checked })} />

          <StyleLibrary ready={ready} lastTrim={lastTrim} />
        </div>
      )}
    </div>
  );
}
