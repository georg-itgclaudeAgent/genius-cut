import type { AudioSource, Snapshot, SnapshotItem, TrimRequest } from "../api/types";
import { formatDuration } from "./timecode";

export function snapshotSummary(s: Snapshot): string {
  const len = formatDuration(s.durationS);
  if (s.video.length === 1) return `${s.video[0].name} · ${s.video[0].label} · ${len}`;
  const v = s.video.map((x) => x.label).join(", "), a = s.audio.map((x) => x.label).join(", ");
  return `${s.video.length} video clips (${v}) + ${s.audio.length} audio (${a}) · ${len}`;
}

export function effectsByClip(s: Snapshot): string[] {
  return [...s.video, ...s.audio].filter((x) => x.effects.length).map((x) => `${x.label}: ${x.effects.join(", ")}`);
}

export const audioKey = (a: SnapshotItem) => `${a.label}:${a.name}`;

export type AudioChoice = { kind: "use"; sources: SnapshotItem[] } | { kind: "ask" };

export function audioChoice(s: Snapshot, remembered: string | null): AudioChoice {
  if (s.audio.length === 1) return { kind: "use", sources: s.audio };
  if (remembered === "mix") return { kind: "use", sources: s.audio };
  const hit = s.audio.find((a) => audioKey(a) === remembered);
  return hit ? { kind: "use", sources: [hit] } : { kind: "ask" };
}

export function trimRequestFor(s: Snapshot, sources: SnapshotItem[], prompt: string): TrimRequest {
  const audio: AudioSource[] = sources.map((a) => ({ media_path: a.mediaPath, in_s: a.inS }));
  return { duration_s: s.durationS, range_start_seq_s: s.startS, audio, prompt };
}

const KEY = (seqId: string) => `geniuscut.audio.${seqId}`;
export function rememberAudio(seqId: string, key: string): void {
  try { localStorage.setItem(KEY(seqId), key); } catch { /* storage unavailable: just ask next time */ }
}
export function recalledAudio(seqId: string): string | null {
  try { return localStorage.getItem(KEY(seqId)); } catch { return null; }
}
