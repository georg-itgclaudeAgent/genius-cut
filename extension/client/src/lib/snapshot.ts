import type { AudioSource, Snapshot, SnapshotItem, TrimRequest } from "../api/types";
import { formatDuration } from "./timecode";
import { round3 } from "./review";

/** Premiere ticks per second. */
const TICKS = 254016000000;

export function snapshotSummary(s: Snapshot): string {
  const len = formatDuration(s.durationS);
  const v = s.video.map((x) => x.label).join(", "), a = s.audio.map((x) => x.label).join(", ");
  if (s.video.length === 1) {
    const audio = s.audio.length > 1 ? ` + ${s.audio.length} audio (${a})` : "";
    return `${s.video[0].name} · ${s.video[0].label}${audio} · ${len}`;
  }
  return `${s.video.length} video clips (${v}) + ${s.audio.length} audio (${a}) · ${len}`;
}

export function effectsByClip(s: Snapshot): string[] {
  return [...s.video, ...s.audio].filter((x) => x.effects.length).map((x) => `${x.label}: ${x.effects.join(", ")}`);
}

export const audioKey = (a: SnapshotItem) => `${a.label}:${a.name}`;

/** preselect: the remembered key ("mix" or an audioKey) if it's still on offer, else null. */
export type AudioChoice = { kind: "use"; sources: SnapshotItem[] } | { kind: "ask"; preselect: string | null };

/** One audio clip is used as is; with several the picker always shows, so a remembered choice can change. */
export function audioChoice(s: Snapshot, remembered: string | null): AudioChoice {
  if (s.audio.length === 1) return { kind: "use", sources: s.audio };
  const still = remembered === "mix" || s.audio.some((a) => audioKey(a) === remembered);
  return { kind: "ask", preselect: still ? remembered : null };
}

/** Each source covers its overlap with the range; a source that doesn't reach into it is left out. */
export function trimRequestFor(s: Snapshot, sources: SnapshotItem[], prompt: string): TrimRequest {
  const r0 = s.startS, r1 = r0 + s.durationS;
  const audio: AudioSource[] = [];
  for (const a of sources) {
    const aStart = Number(a.startTicks) / TICKS, aEnd = Number(a.endTicks) / TICKS;
    const from = Math.max(aStart, r0), to = Math.min(aEnd, r1);
    if (to - from < 0.001) continue;
    audio.push({ media_path: a.mediaPath, in_s: round3(a.inS + (from - aStart)), offset_s: round3(from - r0), duration_s: round3(to - from) });
  }
  if (!audio.length) throw new Error("The selected audio doesn't overlap the selected video clips, so there's nothing to transcribe.");
  return { duration_s: s.durationS, range_start_seq_s: s.startS, audio, prompt };
}

const KEY = (seqId: string) => `geniuscut.audio.${seqId}`;
export function rememberAudio(seqId: string, key: string): void {
  try { localStorage.setItem(KEY(seqId), key); } catch { /* storage unavailable: just ask next time */ }
}
export function recalledAudio(seqId: string): string | null {
  try { return localStorage.getItem(KEY(seqId)); } catch { return null; }
}
