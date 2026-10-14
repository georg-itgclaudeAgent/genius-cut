/**
 * Settings (the gear): "AI key" (the same fields as Setup, re-test, and a notice when the cached key
 * is in use) and "Usage & limit" (this month against the limit, the runs, the $20 / $100 choice and
 * the reset date). Costs are estimates from token usage at list prices.
 */
import { useCallback, useEffect, useState } from "react";
import type { Backend } from "../api/backend";
import type { Settings as SettingsData, Usage, UsageRun } from "../api/types";
import { formatUsd, METER_HOT, meterFraction, modelLabel } from "../lib/cost";
import type { Setup, SetupState } from "../lib/setup";
import { KeyFields, LimitChoice, SignIn, TestRow, useSetup } from "./Setup";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-11-01" → "Resets on 1 November 2026". */
export function resetLine(resetsOn: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(resetsOn);
  return m ? `Resets on ${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : `Resets on ${resetsOn}`;
}

const KINDS: Record<string, string> = { agent: "Instruction", trim: "Trim", summarize: "Style summary" };

/** One run in the list: local day and time, what it was, its cost. */
export function runLine(r: UsageRun): { when: string; what: string; usd: string } {
  const d = new Date(r.at);
  const when = Number.isNaN(d.getTime()) ? r.at
    : `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const kind = KINDS[r.kind] ?? "Other";
  return { when, what: r.model ? `${kind} · ${modelLabel(r.model)}` : kind, usd: formatUsd(r.usd) };
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
          Anthropic's console is the bill of record.</div>
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
              <span className="ct">{l.usd}</span></div>;
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

function AiKeyTab({ api, keyFromCache }: { api: Backend; keyFromCache: boolean }) {
  const [s, setup] = useSetup(api);
  if (!setup) return <div className="sec"><div className="muted">Loading…</div></div>;
  return <KeyTab s={s} setup={setup} keyFromCache={keyFromCache} />;
}

export function SettingsPage({ api, keyFromCache, onClose }: { api: Backend; keyFromCache: boolean; onClose: () => void }) {
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
      {tab === "key" ? <AiKeyTab api={api} keyFromCache={keyFromCache} /> : <UsageTab api={api} />}
    </>
  );
}
