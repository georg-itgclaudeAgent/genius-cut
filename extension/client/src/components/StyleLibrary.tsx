import { useCallback, useEffect, useState } from "react";
import { runtime } from "../api/runtime";
import type { ClipInfo, Library, TrimResponse } from "../api/types";

export interface LastTrim { clip: ClipInfo; res: TrimResponse; checked: boolean[] }

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The words the editor is keeping: everything outside the ticked cuts. */
function keptText(t: LastTrim): string {
  const cuts = t.res.cuts.filter((_, i) => t.checked[i]);
  return t.res.words
    .filter((w) => !cuts.some((c) => w.start >= c.start - 1e-6 && w.end <= c.end + 1e-6))
    .map((w) => w.w).join(" ");
}

export function StyleLibrary({ ready, lastTrim }: { ready: boolean; lastTrim: LastTrim | null }) {
  const [lib, setLib] = useState<Library | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [finalText, setFinalText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setLib(await runtime.backend.library()); setError(null); }
    catch (e) { setError(errMsg(e)); }
  }, []);

  useEffect(() => { if (ready) load(); }, [ready, load]);

  async function save() {
    if (!lastTrim) return;
    setBusy(true);
    try {
      await runtime.backend.addExample(lastTrim.res.words, finalText, lastTrim.clip.name);
      setAdding(false);
      await load();
    } catch (e) { setError(errMsg(e)); }
    finally { setBusy(false); }
  }

  async function summarise() {
    setBusy(true);
    try { await runtime.backend.summarize(); await load(); }
    catch (e) { setError(errMsg(e)); }
    finally { setBusy(false); }
  }

  const count = lib?.examples.length ?? 0;

  return (
    <>
      <div className="sec" style={{ paddingBottom: 8, borderBottom: count ? "none" : undefined }}>
        <div className="sec-hd" style={{ marginBottom: count ? 0 : 7 }}>
          <span className="lbl">Style library</span><span className="spacer" />
          <span className="lbl">{count} {count === 1 ? "example" : "examples"}</span>
        </div>
        {!count && <div className="muted">Add a trimmed clip as an example and future proposals follow your style.</div>}
      </div>

      {count > 0 && (
        <div className="lib-list">
          {lib!.examples.slice(0, 6).map((e) => (
            <div key={e.id} className="lib-item">
              <span className="nm">{e.source_clip}</span>
              <span className="ct">{e.removed_spans.length} removed · {e.created.slice(0, 10)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="sec stack">
        {error && <div className="note bad">{error}</div>}

        {lib?.summary && (
          <div>
            <div className="lbl" style={{ marginBottom: 4 }}>Your style, summarised</div>
            <p className="summary-text">{lib.summary}</p>
          </div>
        )}

        {adding && lastTrim ? (
          <div className="stack">
            <div className="lbl">Final text for {lastTrim.clip.name}</div>
            <textarea className="field" value={finalText} onChange={(e) => setFinalText(e.target.value)} aria-label="Final text" />
            <div className="muted">Edit it to read exactly how you'd cut it. The removed words are worked out from the difference.</div>
            <div className="prompt">
              <button className="btn btn-g" onClick={() => setAdding(false)} disabled={busy}>Cancel</button>
              <span className="spacer" />
              <button className="btn btn-p" onClick={save} disabled={busy || !finalText.trim()}>Save example</button>
            </div>
          </div>
        ) : (
          <div className="prompt" style={{ flexWrap: "wrap" }}>
            <button className="btn btn-g" disabled={!ready || !lastTrim || busy}
              title={lastTrim ? "" : "Analyse a clip first"}
              onClick={() => { if (lastTrim) { setFinalText(keptText(lastTrim)); setAdding(true); } }}>
              Add last clip
            </button>
            <span className="spacer" />
            <button className="btn btn-g" onClick={summarise} disabled={!ready || !count || busy}>
              {busy ? "Working…" : "Summarise style"}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
