/**
 * live    — inside Premiere: real backend (spawned if needed) and real timeline edits.
 * preview — inside Premiere, preview build: the real panel on sample data; no backend.
 * browser — `npm run dev` outside Premiere: sample data.
 *
 * A preview build is set by VITE_GENIUSCUT_PREVIEW=1 (extension/client/.env.production).
 * It lets Genius Cut ship and install before the backend does; turning it off and tagging
 * the next version is the whole switch to the real thing.
 */
export type Mode = "live" | "preview" | "browser";

export function pickMode({ inPremiere, previewBuild }: { inPremiere: boolean; previewBuild: boolean }): Mode {
  if (!inPremiere) return "browser";
  return previewBuild ? "preview" : "live";
}
