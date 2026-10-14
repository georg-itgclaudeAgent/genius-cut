/**
 * The Setup page (live mode, before Genius Cut can be used): the editor's own Anthropic key, read
 * from their own Google Cloud project with their own gcloud login. Steps and logic: lib/setup.ts.
 */
import { useEffect, useState, type ReactNode } from "react";
import { createSetup, filterProjects, initialSetup, INSTALL_URL, steps, validProject, type Setup, type SetupApi, type SetupState, type StepId } from "../lib/setup";

/** The setup controller as React state. */
export function useSetup(api: SetupApi): [SetupState, Setup | null] {
  const [state, setState] = useState<SetupState | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  useEffect(() => {
    const s = createSetup(api, { onChange: setState });
    setSetup(s);
    setState(s.state);
    void s.start();
    return () => s.stop();
  }, [api]);
  return [state ?? initialSetup(), setup];
}

function StepBlock({ n, title, status, line, children }: { n: number; title: string; status: string; line?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`step ${status}`}>
      <span className="step-n">{status === "done" ? "✓" : n}</span>
      <div className="step-body">
        <div className="step-t">{title}</div>
        {line && <div className="step-line">{line}</div>}
        {status !== "todo" && children}
      </div>
    </div>
  );
}

const Note = ({ bad, children }: { bad?: boolean; children: ReactNode }) => <div className={`note${bad ? " bad" : ""}`} style={{ marginTop: 6 }}>{children}</div>;

/** Sign in with Google: gcloud auth login on this PC. */
export function SignIn({ s, setup }: { s: SetupState; setup: Setup }) {
  const running = s.login.state === "running";
  return (
    <>
      <div className="actions-row">
        <button className="btn btn-g" onClick={() => setup.signIn()} disabled={running}>Sign in with Google</button>
      </div>
      {running ? <div className="step-line">Finish signing in in your browser. Genius Cut never sees your password.</div>
        : <div className="step-line">Your browser opens; you sign in there. Genius Cut never sees your password.</div>}
      {s.login.state === "failed" && <Note bad>{s.login.message}</Note>}
    </>
  );
}

/** The project: search the listed ones, or type an id. */
export function ProjectPicker({ s, setup }: { s: SetupState; setup: Setup }) {
  const list = filterProjects(s.projects.items ?? [], s.query);
  const typed = s.query.trim();
  const listed = (s.projects.items ?? []).some((p) => p.id === typed);
  return (
    <div>
      <input className="field wide" value={s.query} placeholder="Search, or type a project ID" aria-label="Project"
        onChange={(e) => setup.setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void setup.chooseProject(s.query); }} />
      {s.projects.loading && <div className="step-line">Listing your projects…</div>}
      {s.projects.error && <Note bad>{s.projects.error}</Note>}
      {(list.length > 0 || (validProject(typed) && !listed)) && (
        <div className="pick-list" role="listbox" aria-label="Projects">
          {list.map((p) => (
            <button key={p.id} className={`pick${p.id === s.project ? " on" : ""}`} role="option" aria-selected={p.id === s.project}
              onClick={() => setup.chooseProject(p.id)}>
              <span>{p.name || p.id}</span><span className="pick-id">{p.id}</span>
            </button>
          ))}
          {validProject(typed) && !listed && (
            <button className={`pick${typed === s.project ? " on" : ""}`} onClick={() => setup.chooseProject(typed)}>Use {typed}</button>
          )}
        </div>
      )}
      {s.projectError && <Note bad>{s.projectError}</Note>}
    </div>
  );
}

/** The secret's name (with the project's listed ones) and its version (latest, or an enabled one). */
export function SecretPicker({ s, setup }: { s: SetupState; setup: Setup }) {
  const versions = ["latest", ...(s.versions.items ?? []).filter((v) => v.state === "enabled").map((v) => v.version)];
  if (!versions.includes(s.version)) versions.push(s.version);
  return (
    <>
      <div className="key-row">
        <label style={{ flex: 2, minWidth: 0 }}>
          <div className="lbl">Secret</div>
          <input className="field wide" list="gcut-secrets" value={s.secret} aria-label="Secret"
            onChange={(e) => setup.setSecret(e.target.value)} onBlur={(e) => setup.chooseSecret(e.target.value)} />
          <datalist id="gcut-secrets">{(s.secrets.items ?? []).map((x) => <option key={x} value={x} />)}</datalist>
        </label>
        <label style={{ flex: 1, minWidth: 0 }}>
          <div className="lbl">Version</div>
          <select className="field wide" value={s.version} aria-label="Version" onChange={(e) => setup.chooseVersion(e.target.value)}>
            {versions.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
      </div>
      {s.secrets.error && <Note bad>{s.secrets.error}</Note>}
      {s.versions.error && <Note bad>{s.versions.error}</Note>}
    </>
  );
}

/** Project, secret and version together (Settings' AI key tab). */
export function KeyFields({ s, setup }: { s: SetupState; setup: Setup }) {
  return (
    <div className="stack">
      <div><div className="lbl">Project</div><ProjectPicker s={s} setup={setup} /></div>
      {s.project && <SecretPicker s={s} setup={setup} />}
    </div>
  );
}

/** The key test's button and its result, as the backend words it. */
export function TestRow({ s, setup, label }: { s: SetupState; setup: Setup; label: string }) {
  return (
    <>
      <div className="actions-row">
        <button className="btn btn-g" onClick={() => setup.test()} disabled={s.test.state === "running" || !s.project}>{label}</button>
      </div>
      {s.test.state === "running" && <div className="step-line">{s.test.message}</div>}
      {s.test.state === "ok" && <Note>{s.test.message}</Note>}
      {s.test.state === "failed" && <Note bad>{s.test.message}</Note>}
    </>
  );
}

/** $20 (default) or $100 (the most). */
export function LimitChoice({ tier, onTier, disabled }: { tier: 20 | 100; onTier: (t: 20 | 100) => void; disabled?: boolean }) {
  return (
    <div className="seg" role="group" aria-label="Monthly limit">
      {([20, 100] as const).map((t) => (
        <button key={t} className="seg-b" aria-pressed={tier === t} disabled={disabled} onClick={() => onTier(t)}>${t} / month</button>
      ))}
    </div>
  );
}

export function SetupView({ s, setup, onFinish, openUrl }: { s: SetupState; setup: Setup; onFinish: () => void; openUrl: (url: string) => void }) {
  const st = Object.fromEntries(steps(s).map((x) => [x.id, x.status])) as Record<StepId, string>;
  const g = s.gcloud;
  return (
    <div className="sec setup">
      <div className="setup-hd">Set up Genius Cut</div>
      <div className="muted" style={{ marginBottom: 10 }}>
        Genius Cut's AI runs on your own Anthropic key, kept in your own Google Cloud project. You do this once.
      </div>

      <StepBlock n={1} title="Google Cloud CLI" status={st.gcloud}
        line={s.checking ? "Checking…" : g?.installed ? `Installed · ${g.version ?? "unknown version"}` : g ? "Not installed on this PC." : null}>
        {!g?.installed && (
          <>
            <div className="step-line">Install the Google Cloud CLI, then check again: <span className="tc">{INSTALL_URL}</span></div>
            <div className="actions-row">
              <button className="btn btn-g" onClick={() => openUrl(INSTALL_URL)}>Install the Google Cloud CLI</button>
              <button className="btn btn-g" onClick={() => setup.check()} disabled={s.checking}>Check again</button>
            </div>
          </>
        )}
        {s.gcloudError && <Note bad>{s.gcloudError}</Note>}
      </StepBlock>

      <StepBlock n={2} title="Sign in" status={st.signin} line={g?.account ? `Signed in as ${g.account}` : null}>
        {!g?.account && <SignIn s={s} setup={setup} />}
      </StepBlock>

      <StepBlock n={3} title="Project" status={st.project}
        line={s.project ? `Using ${s.project}` : "The Google Cloud project whose Secret Manager holds your Anthropic API key."}>
        <ProjectPicker s={s} setup={setup} />
      </StepBlock>

      <StepBlock n={4} title="Secret" status={st.secret} line="The secret that holds the key, and which version (latest unless told otherwise).">
        <SecretPicker s={s} setup={setup} />
      </StepBlock>

      <StepBlock n={5} title="Test" status={st.test} line="Reads your key and makes one free call to Anthropic.">
        <TestRow s={s} setup={setup} label="Test" />
      </StepBlock>

      <StepBlock n={6} title="Monthly limit" status={st.limit} line="What Genius Cut's AI may spend each month. $20 is the default; $100 is the most.">
        <LimitChoice tier={s.limit} onTier={(t) => setup.setLimit(t)} disabled={s.finishing} />
        {s.finishError && <Note bad>{s.finishError}</Note>}
        <div className="actions-row">
          <button className="btn btn-p" disabled={s.finishing} onClick={async () => { if (await setup.finish()) onFinish(); }}>Finish</button>
        </div>
      </StepBlock>
    </div>
  );
}

/** The Setup page with its controller. */
export function SetupPage({ api, onDone, openUrl }: { api: SetupApi; onDone: () => void; openUrl: (url: string) => void }) {
  const [s, setup] = useSetup(api);
  if (!setup) return <div className="sec"><div className="status"><span className="pip busy" /><span>Loading setup…</span></div></div>;
  return <SetupView s={s} setup={setup} onFinish={onDone} openUrl={openUrl} />;
}
