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

export interface SnapshotItem {
  kind: "video" | "audio";
  trackIndex: number;
  label: string;          // "V1", "A2": what the editor sees
  startTicks: string;     // exact timeline position in ticks: how the host finds the clip again
  endTicks: string;
  name: string;
  mediaPath: string;
  inS: number;
  outS: number;
  /** Playback speed: 1 = 100%, negative = reversed. Only 1 is trimmed. */
  speed: number;
  /** Effects on the clip (beyond Motion/Opacity/Volume...). The rebuild does NOT keep them. */
  effects: string[];
}

/** What the host reports about the selected range: every clip in it, across tracks. */
export interface Snapshot {
  found: true;
  sequenceId: string;
  startTicks: string;
  endTicks: string;
  startS: number;
  durationS: number;
  fps: number;
  video: SnapshotItem[];
  audio: SnapshotItem[];
  problems: string[];
}

export interface NotFound { found: false; message: string }

/** One audio clip's place in the range: where it starts (offset_s from the range start), how long, and its in point there. */
export interface AudioSource { media_path: string; in_s: number; offset_s: number; duration_s: number }

export interface TrimRequest {
  duration_s: number;
  range_start_seq_s: number;
  audio: AudioSource[];
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
  kept_spans: Span[];     // range-relative; what the host re-lays
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
  /** Panel <-> backend contract version, and the backend's process id (both absent on old backends). */
  api?: number;
  pid?: number;
  /** While stt_device is "loading": "downloading" only when the model isn't on this PC yet. */
  stt_phase?: "loading" | "downloading";
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
