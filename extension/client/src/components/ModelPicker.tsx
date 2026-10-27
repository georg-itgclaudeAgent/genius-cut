/**
 * The AI model picker under the instruction box, beside the cost line (model picker spec "User Experience"):
 * the catalog grouped by provider, each with its price; models that are blocked or need setup are listed
 * but can't be picked, and when the saved one is among them the reason shows under the picker. Picking
 * saves the model (`PUT /settings/model`) for the next Send / Analyse, then the panel re-reads /health so
 * the cost line follows. ↻ re-checks every provider (`GET /models?refresh=1`).
 */
import { useCallback, useEffect, useState } from "react";
import type { Backend } from "../api/backend";
import type { ModelEntry, ModelListing } from "../api/types";

/** `$4`, `$0.10`, `$3.75`: whole dollars without cents. */
const price = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

/** "Claude Opus 5.5 (Anthropic) — $4/$20 per MTok" (input / output USD per million tokens). */
export function optionText(m: ModelEntry): string {
  return `${m.label} — ${m.price ? `${price(m.price.input)}/${price(m.price.output)} per MTok` : "price unknown"}`;
}

type PickerApi = Pick<Backend, "models" | "setModel">;

/** Save the choice, then re-read the list (the new selection) and the health (the cost line). */
export async function switchModel(api: PickerApi, id: string, refreshHealth: () => Promise<void>): Promise<ModelListing> {
  await api.setModel(id);
  const listing = await api.models();
  await refreshHealth();
  return listing;
}

export function ModelPickerView({ listing, busy, error, onPick, onRefresh }: {
  listing: ModelListing; busy: boolean; error: string | null; onPick: (id: string) => void; onRefresh: () => void;
}) {
  const groups: string[] = [];
  for (const m of listing.models) if (!groups.includes(m.group)) groups.push(m.group);
  const current = listing.models.find((m) => m.id === listing.selected);
  return (
    <div className="model-pick">
      <div className="model-row">
        <select className="field model-sel" aria-label="AI model" value={listing.selected} disabled={busy}
          title={current ? optionText(current) : undefined} onChange={(e) => onPick(e.target.value)}>
          {groups.map((g) => (
            <optgroup label={g} key={g}>
              {listing.models.filter((m) => m.group === g).map((m) => (
                <option value={m.id} disabled={m.state !== "ok"} key={m.id}>
                  {optionText(m)}{m.state !== "ok" ? ` · ${m.message}` : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button className="btn btn-g model-ref" type="button" title="Check the models again" aria-label="Check the models again"
          disabled={busy} onClick={onRefresh}>↻</button>
      </div>
      {current && current.state !== "ok" && <div className="model-why" role="status">{current.label}: {current.message}</div>}
      {error && <div className="model-why bad" role="alert">{error}</div>}
    </div>
  );
}

/** Loads the list once; nothing shows until it's read. `onSwitched` re-reads /health. */
export function ModelPicker({ api, onSwitched }: { api: PickerApi; onSwitched: () => Promise<void> }) {
  const [listing, setListing] = useState<ModelListing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const work = useCallback(async (job: () => Promise<ModelListing>) => {
    setBusy(true);
    try {
      setListing(await job());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => { void work(() => api.models()); }, [api, work]);
  if (!listing) return error ? <div className="model-pick"><div className="model-why bad" role="alert">{error}</div></div> : null;
  return <ModelPickerView listing={listing} busy={busy} error={error}
    onPick={(id) => { if (id !== listing.selected) void work(() => switchModel(api, id, onSwitched)); }}
    onRefresh={() => void work(() => api.models(true))} />;
}
