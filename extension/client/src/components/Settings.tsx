/**
 * Settings (the gear): "AI key" (the same fields as Setup, re-test, a notice when the cached key
 * is in use, Claude via Google Cloud (Vertex): sign-in, project, region and each model's state, and Graphics: what a
 * render needs and the one-time "Set up graphics") and "Usage & limit" (this month against the limit, the runs, the $20 / $100 choice and
 * the reset date). Costs are estimates from token usage at list prices.
 */
import { useCallback, useEffect, useState } from "react";
import { BackendError, type Backend } from "../api/backend";
import type { GraphicsStatus, LoginStatus, ModelListing, Settings as SettingsData, Usage, UsageRun } from "../api/types";
import { formatUsd, METER_HOT, meterFraction } from "../lib/cost";
import type { Setup, SetupState } from "../lib/setup";
import { KeyFields, LimitChoice, SignIn, TestRow, useSetup } from "./Setup";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-11-01" → "Resets on 1 November 2026". */
export function resetLine(resetsOn: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(resetsOn);
  return m ? `Resets on ${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : `Resets on ${resetsOn}`;
}

const KINDS: Record<string, string> = { agent: "Instruction", trim: "Trim", summarize: "Style summary" };

const PROVIDERS: Record<string, string> = { anthropic: "Anthropic", vertex: "Google Cloud", gemini: "Gemini API" };

/** One run in the list: local day and time, what it was (with the model's label), who bills it, its cost. */
export function runLine(r: UsageRun): { when: string; what: string; provider: string; usd: string } {
  const d = new Date(r.at);
  const when = Number.isNaN(d.getTime()) ? r.at
    : `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const kind = KINDS[r.kind] ?? "Other";
  const label = r.label || r.model;
  return { when, what: label ? `${kind} · ${label}` : kind, provider: PROVIDERS[r.provider] ?? "", usd: formatUsd(r.usd) };
}

export function KeyTab({ s, setup, keyFromCache }: { s: SetupState; setup: Setup; keyFromCache: boolean }) {
  return (
    <div className="sec">
      {keyFromCache && (
        <div className="note warn" style={{ marginBottom: 10 }}>
          Genius Cut is using the saved copy of your key: gcloud couldn't read Secret Manager, so your Google sign-in has
          probably expired. Sign in again to keep it current.
          <SignIn s={s} setup={setup} />
        </div>
      )}
      <div className="muted" style={{ marginBottom: 8 }}>Where your Anthropic key lives: your own Google Cloud project's Secret Manager.</div>
      <KeyFields s={s} setup={setup} />
      <TestRow s={s} setup={setup} label="Test and save" />
    </div>
  );
}

export function UsageView({ usage, tier, saving, error, onTier }: {
  usage: Usage; tier: 20 | 100; saving: boolean; error: string | null; onTier: (t: 20 | 100) => void;
}) {
  const f = meterFraction(usage.month_usd, usage.limit_usd);
  return (
    <>
      <div className="sec">
        <div className="sec-hd"><span className="lbl">This month</span><span className="spacer" />
          <span className="cost-line">{formatUsd(usage.month_usd)} of {formatUsd(usage.limit_usd)}</span></div>
        <div className={`meter big-meter${f >= METER_HOT ? " hot" : ""}`} role="meter" aria-label="AI spend this month"
          aria-valuemin={0} aria-valuemax={usage.limit_usd} aria-valuenow={usage.month_usd}>
          <span style={{ width: `${+(f * 100).toFixed(1)}%` }} />
        </div>
        <div className="step-line" style={{ marginTop: 6 }}>{resetLine(usage.resets_on)} · estimates from token use at list prices;
          Anthropic's console and Google Cloud billing are the bills of record.</div>
      </div>
      <div className="sec">
        <div className="sec-hd"><span className="lbl">Monthly limit</span></div>
        <LimitChoice tier={tier} onTier={onTier} disabled={saving} />
        {error && <div className="note bad" style={{ marginTop: 6 }}>{error}</div>}
      </div>
      <div className="sec" style={{ paddingBottom: 4 }}>
        <div className="sec-hd"><span className="lbl">Runs</span><span className="spacer" />
          <span className="muted">{usage.run_count} {usage.run_count === 1 ? "run" : "runs"} this month</span></div>
        {usage.runs.length === 0 && <div className="muted">No AI runs yet this month.</div>}
      </div>
      {usage.runs.length > 0 && (
        <div className="lib-list">
          {usage.runs.map((r, i) => {
            const l = runLine(r);
            return <div className="lib-item" key={`${r.at}-${i}`}><span className="tc muted">{l.when}</span><span className="nm">{l.what}</span>
              {l.provider && <span className="pv">{l.provider}</span>}<span className="ct">{l.usd}</span></div>;
          })}
        </div>
      )}
    </>
  );
}

function UsageTab({ api }: { api: Backend }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [u, s] = await Promise.all([api.usage(), api.settings()]);
      setUsage(u); setSettings(s); setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  async function onTier(t: 20 | 100) {
    if (!settings || t === settings.monthly_limit_usd) return;
    setSaving(true);
    try {
      setSettings(await api.saveSettings({ ...settings, monthly_limit_usd: t }));
      setUsage(await api.usage());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!usage) return <div className="sec">{error ? <div className="note bad">{error}</div> : <div className="muted">Loading…</div>}</div>;
  return <UsageView usage={usage} tier={settings?.monthly_limit_usd ?? usage.limit_tier} saving={saving} error={error} onTier={onTier} />;
}

const POLL_MS = 2000;

/**
 * "Set up graphics": start the one-time setup (a setup already running, 409, is just watched), then read the status
 * every 2 s, showing each, until the setup is no longer running. Returns the last status.
 */
export async function runGraphicsSetup(api: Pick<Backend, "graphicsSetup" | "graphicsStatus">, onStatus: (s: GraphicsStatus) => void,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<GraphicsStatus> {
  try {
    await api.graphicsSetup();
  } catch (e) {
    if (!(e instanceof BackendError && e.status === 409)) throw e;
  }
  for (;;) {
    await sleep(POLL_MS);
    const st = await api.graphicsStatus();
    onStatus(st);
    if (st.setup.state !== "running") return st;
  }
}

/** One status line: a pip, what it is, and its version or path. */
function Part({ ok, name, det }: { ok: boolean; name: string; det: string | null }) {
  return <div className="row"><span className={`pip ${ok ? "ok" : "bad"}`} /><span>{name}</span><span className="det">{det ?? "not found"}</span></div>;
}

export function GraphicsView({ status, busy, error, onSetup }: {
  status: GraphicsStatus | null; busy: boolean; error: string | null; onSetup: () => void;
}) {
  const running = busy || status?.setup.state === "running";
  return (
    <div className="sec">
      <div className="sec-hd"><span className="lbl">Graphics</span></div>
      {status && (
        <>
          <div className="muted">{status.message}</div>
          <div className="gfx-status" aria-label="What graphics need">
            <Part ok={status.node.ok} name="Node.js" det={status.node.version} />
            <Part ok={status.cli.ok} name="HyperFrames" det={status.cli.version} />
            <Part ok={status.chrome.ok} name="Chrome" det={status.chrome.ok ? "ready" : null} />
            <Part ok={status.ffmpeg.ok} name="FFmpeg" det={status.ffmpeg.ok ? "ready" : null} />
          </div>
          {status.setup.state === "running" && status.setup.message && <div className="step-line">{status.setup.message}</div>}
          {status.setup.state === "failed" && <div className="note bad">{status.setup.message}</div>}
        </>
      )}
      {!status && !error && <div className="muted">Loading…</div>}
      {error && <div className="note bad">{error}</div>}
      {(!status || !status.ready) && (
        <div className="actions-row" style={{ marginTop: 8 }}>
          <button className="btn btn-p" onClick={onSetup} disabled={running}>{running ? "Setting up…" : "Set up graphics"}</button>
        </div>
      )}
    </div>
  );
}

function GraphicsSection({ api }: { api: Backend }) {
  const [status, setStatus] = useState<GraphicsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.graphicsStatus().then((st) => { if (live) { setStatus(st); setError(null); } },
      (e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [api]);

  async function onSetup() {
    setBusy(true); setError(null);
    try {
      await runGraphicsSetup(api, setStatus);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return <GraphicsView status={status} busy={busy} error={error} onSetup={() => void onSetup()} />;
}

export const modelGardenUrl = (project: string) =>
  `https://console.cloud.google.com/vertex-ai/model-garden?project=${encodeURIComponent(project)}`;

/**
 * "Sign in" for Vertex: start the gcloud Application Default Credentials sign-in for `project` (one already running,
 * 409, is just watched), then read its status every 2 s, showing each, until it's no longer running.
 */
export async function runVertexLogin(api: Pick<Backend, "vertexLogin" | "vertexLoginStatus">, project: string,
  onStatus: (s: LoginStatus) => void, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<LoginStatus> {
  try {
    await api.vertexLogin(project);
  } catch (e) {
    if (!(e instanceof BackendError && e.status === 409)) throw e;
  }
  for (;;) {
    await sleep(POLL_MS);
    const st = await api.vertexLoginStatus();
    onStatus(st);
    if (st.state !== "running") return st;
  }
}

export function VertexView({ listing, project, region, login, busy, error, saved, onProject, onRegion, onSave, onSignIn, openUrl }: {
  listing: ModelListing | null; project: string; region: string; login: LoginStatus | null; busy: boolean; error: string | null;
  saved: boolean; onProject: (v: string) => void; onRegion: (v: string) => void; onSave: () => void; onSignIn: () => void;
  openUrl: (url: string) => void;
}) {
  const v = listing?.vertex;
  const signingIn = login?.state === "running";
  const signedIn = !!v?.adc && !!v.quota_project;
  return (
    <div className="sec">
      <div className="sec-hd"><span className="lbl">Claude via Google Cloud (Vertex)</span></div>
      <div className="muted">Claude billed to your Google Cloud project instead of the Anthropic key. You sign in in your browser.</div>
      {v && (
        <div className="gfx-status" aria-label="Vertex sign-in">
          <Part ok={v.adc} name="Google sign-in" det={v.adc ? "Signed in (Application Default Credentials)" : "Not signed in"} />
          <Part ok={!!v.quota_project} name="Quota project" det={v.quota_project ?? "not set"} />
        </div>
      )}
      {!listing && !error && <div className="muted">Loading…</div>}
      <div className="actions-row">
        <button className={`btn ${signedIn ? "btn-g" : "btn-p"}`} onClick={onSignIn} disabled={signingIn || busy || !project.trim()}>
          {signingIn ? "Signing in…" : signedIn ? "Sign in again" : "Sign in"}</button>
      </div>
      {signingIn && login.message && <div className="step-line">{login.message}</div>}
      {login?.state === "failed" && <div className="note bad">{login.message}</div>}
      <div className="key-row" style={{ marginTop: 8 }}>
        <label style={{ flex: 2, minWidth: 0 }}>
          <div className="lbl">Project</div>
          <input className="field wide" value={project} aria-label="Vertex project" onChange={(e) => onProject(e.target.value)} />
        </label>
        <label style={{ flex: 1, minWidth: 0 }}>
          <div className="lbl">Region</div>
          <input className="field wide" value={region} aria-label="Vertex region" onChange={(e) => onRegion(e.target.value)} />
        </label>
      </div>
      <div className="actions-row">
        <button className="btn btn-g" onClick={onSave} disabled={busy || !project.trim() || !region.trim()}>Save</button>
        {saved && <span className="muted">Saved.</span>}
      </div>
      {error && <div className="note bad">{error}</div>}
      {listing && (
        <div className="gfx-status" aria-label="Claude models on Vertex">
          {listing.models.filter((m) => m.provider === "vertex").map((m) => (
            <div className="row" key={m.id}>
              <span className={`pip ${m.state === "ok" ? "ok" : "bad"}`} /><span>{m.label.replace(/ \(Google Cloud\)$/, "")}</span>
              {m.state !== "ok" && /model garden/i.test(m.message)
                ? <button className="btn-link det-link" onClick={() => openUrl(modelGardenUrl(project.trim() || v!.project))}>Enable in Model Garden</button>
                : <span className="det">{m.state === "ok" ? "Enabled" : m.message}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function VertexSection({ api, openUrl }: { api: Backend; openUrl: (url: string) => void }) {
  const [listing, setListing] = useState<ModelListing | null>(null);
  const [project, setProject] = useState("");
  const [region, setRegion] = useState("");
  const [login, setLogin] = useState<LoginStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const show = (l: ModelListing) => { setListing(l); setProject(l.vertex.project); setRegion(l.vertex.region); };
  useEffect(() => {
    let live = true;
    api.models().then((l) => { if (live) show(l); }, (e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [api]);

  async function work(job: () => Promise<void>) {
    setBusy(true); setError(null); setSaved(false);
    try { await job(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  const onSave = () => work(async () => {
    await api.saveSettings({ vertex: { project: project.trim(), region: region.trim() } });
    show(await api.models());
    setSaved(true);
  });
  // A finished sign-in drops the backend's cached Vertex states, so the list re-checks them.
  const onSignIn = () => work(async () => {
    await runVertexLogin(api, project.trim(), setLogin);
    show(await api.models());
  });
  return <VertexView listing={listing} project={project} region={region} login={login} busy={busy} error={error} saved={saved}
    onProject={(x) => { setProject(x); setSaved(false); }} onRegion={(x) => { setRegion(x); setSaved(false); }}
    onSave={() => void onSave()} onSignIn={() => void onSignIn()} openUrl={openUrl} />;
}

function AiKeyTab({ api, keyFromCache, openUrl }: { api: Backend; keyFromCache: boolean; openUrl: (url: string) => void }) {
  const [s, setup] = useSetup(api);
  if (!setup) return <div className="sec"><div className="muted">Loading…</div></div>;
  return <><KeyTab s={s} setup={setup} keyFromCache={keyFromCache} /><VertexSection api={api} openUrl={openUrl} /><GraphicsSection api={api} /></>;
}

export function SettingsPage({ api, keyFromCache, openUrl, onClose }: {
  api: Backend; keyFromCache: boolean; openUrl: (url: string) => void; onClose: () => void;
}) {
  const [tab, setTab] = useState<"key" | "usage">("key");
  return (
    <>
      <div className="sec settings-hd">
        <span className="setup-hd">Settings</span><span className="spacer" />
        <button className="btn btn-g" onClick={onClose}>Close</button>
      </div>
      <div className="tabs" role="tablist">
        <button className="tab" role="tab" aria-selected={tab === "key"} onClick={() => setTab("key")}>AI key</button>
        <button className="tab" role="tab" aria-selected={tab === "usage"} onClick={() => setTab("usage")}>Usage &amp; limit</button>
      </div>
      {tab === "key" ? <AiKeyTab api={api} keyFromCache={keyFromCache} openUrl={openUrl} /> : <UsageTab api={api} />}
    </>
  );
}
