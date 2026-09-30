/** Mirrors backend/geniuscut/models.py. Source time = seconds into the media file;
 *  sequence time = seconds on the timeline (display only). */

export interface Word { w: string; start: number; end: number }

export interface Span { start: number; end: number }

export interface SequenceCut {
  start: number;          // span-relative seconds
  end: number;
  text: string;
  reason: string;
  start_seq_s: number;    // timeline position, display only
  end_seq_s: number;
}

export interface TrimRequest {
  media_path: string;
  in_s: number;
  out_s: number;
  clip_start_s: number;
  prompt: string;
}

export interface TrimResponse {
  words: Word[];
  cuts: SequenceCut[];
  kept_spans_source: Span[];
  stt_device: string;
  cut_fraction: number;
  warning: string | null;
}

export interface Health {
  status: "ok" | "error";
  version: string;
  stt_device: string;     // "cuda" | "cpu" | "loading" | "failed"
  error?: string;
}

export interface RemovedSpan { start: number; end: number; text: string; reason: string }

export interface StyleExample {
  id: string;
  created: string;
  source_clip: string;
  raw_words: Word[];
  final_text: string;
  removed_spans: RemovedSpan[];
}

export interface Library { examples: StyleExample[]; summary: string | null }

/** What the host (ExtendScript, Phase C) reports about the target clip. */
export interface ClipInfo {
  found: boolean;
  name: string;
  mediaPath: string;
  trackIndex: number;
  inS: number;
  outS: number;
  startS: number;
  fps: number;
  matchCount: number;
  selectedUsed: boolean;
}
