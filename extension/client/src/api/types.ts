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

/** What one run's AI calls cost, and where the month stands afterwards. USD throughout. */
export interface RunCost {
  model: string;
  input_tokens: number;
  output_tokens: number;
  usd: number | null;     // null: the model has no price (Claude)
  month_usd: number;
  limit_usd: number;
}

export interface TrimResponse {
  words: Word[];
  cuts: SequenceCut[];
  kept_spans_source: Span[];
  stt_device: string;
  cut_fraction: number;
  warning: string | null;
  cost?: RunCost | null;  // absent from backends older than the spend limit
}

/** The AI provider and the month's spend, from /health. Never carries a key. */
export interface AiStatus {
  provider: string;       // "gemini" | "anthropic" | "vertex" | "unknown"
  model: string | null;
  month_usd: number | null;       // null: the spend ledger couldn't be read
  limit_usd: number;
  usd_per_minute: number | null;  // null: the model has no price
}

export interface Health {
  status: "ok" | "error";
  version: string;
  stt_device: string;     // "cuda" | "cpu" | "loading" | "failed"
  error?: string;
  ai?: AiStatus;
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
  /** Exact timeline start in ticks: how the host finds this clip again (names repeat). */
  startTicks: string;
  inS: number;
  outS: number;
  startS: number;
  fps: number;
  matchCount: number;
  selectedUsed: boolean;
  /** Playback speed: 1 = 100%, negative = reversed. Phase 1 only trims 1. */
  speed: number;
  /** Effects on the clip (beyond Motion/Opacity/Volume…). The rebuild does NOT keep them. */
  effects: string[];
}
