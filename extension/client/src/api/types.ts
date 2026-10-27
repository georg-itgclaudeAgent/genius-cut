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
  /** The sequence's frame length, seconds: cut edges come back on its frames. Omitted: edges as found. */
  frame_s?: number;
}

/** `POST /transcript` (the assistant): a TrimRequest's audio and range. */
export type TranscriptRequest = Pick<TrimRequest, "duration_s" | "range_start_seq_s" | "audio">;

/** A transcript job. `words` (range-relative seconds) only once `status` is "done"; "loading": queued until the speech model is ready. */
export interface TranscriptJob {
  id: string;
  status: "running" | "loading" | "done" | "error";
  progress: number;
  words?: Word[] | null;
  error?: string | null;
}

/** What one run's AI calls cost, and where the month stands afterwards. USD throughout. */
export interface RunCost {
  /** The catalog id of the model that answered last (`gemini:gemini-3.8-flash`), its picker label and provider. */
  model: string;
  label: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  usd: number | null;     // null: the model has no price
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

/** The selected model and the month's spend, from /health. Never carries a key. */
export interface AiStatus {
  provider: string;       // "gemini" | "anthropic" | "vertex" | "unknown"
  /** The selected model's catalog id and its picker label ("Claude Opus 5.5 (Anthropic)"). */
  model_id: string | null;
  label: string | null;
  month_usd: number | null;       // null: the spend ledger couldn't be read
  limit_usd: number;
  usd_per_minute: number | null;  // null: the model has no price
  /** The editor's chosen monthly limit, 20 or 100 (absent on backends before the Setup page). */
  limit_tier?: 20 | 100;
  /** The key in use is the encrypted local copy: gcloud couldn't read Secret Manager (login expired?). */
  key_from_cache?: boolean;
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

// ── Setup page and Settings (backend/geniuscut/setup.py, settings.py, spend.usage) ──

/** Where the editor's Anthropic key lives: their own GCP project's Secret Manager. */
export interface KeySource { project: string; secret: string; version: string }

export interface Settings {
  anthropic_key: KeySource;
  monthly_limit_usd: 20 | 100;
  /** Set only by a passing key test. */
  setup_complete: boolean;
  /** The picker's model (catalog id) and where Claude on Vertex runs. */
  model: string;
  vertex: VertexSettings;
}

/** `PUT /settings` merges: only the fields sent change. */
export type SettingsPatch = Partial<Omit<Settings, "vertex">> & { vertex?: Partial<VertexSettings> };

export interface VertexSettings { project: string; region: string }

// ── The AI model picker (backend/geniuscut/catalog.py, GET /models) ──

export interface ModelEntry {
  id: string;             // catalog id, "<provider>:<model>"
  label: string;
  provider: "anthropic" | "vertex" | "gemini";
  group: string;          // "Claude (Anthropic key)" | "Claude (Google Cloud)" | "Gemini"
  /** USD per 1M tokens today; null: no known price. */
  price: { input: number; output: number } | null;
  usd_per_minute: number | null;
  /** ok: usable; blocked / setup: listed but not selectable, `message` says why. */
  state: "ok" | "blocked" | "setup";
  message: string;
}

export interface ModelListing {
  selected: string;
  models: ModelEntry[];
  /** adc: Application Default Credentials found on this PC. */
  vertex: VertexSettings & { adc: boolean; quota_project: string | null };
}

export interface KeyTest { ok: boolean; message: string }

/** account null: nobody is signed in to gcloud. */
export interface GcloudStatus { installed: boolean; path: string | null; version: string | null; account: string | null }

export interface LoginStatus { state: "idle" | "running" | "done" | "failed"; message: string }

export interface GcpProject { id: string; name: string }

export interface SecretVersion { version: string; state: string }

export interface UsageRun { at: string; kind: string; model: string; label: string; provider: string; usd: number | null }

export interface Usage {
  month_usd: number;
  limit_usd: number;
  limit_tier: 20 | 100;
  /** YYYY-MM-DD: the 1st of next month. */
  resets_on: string;
  run_count: number;
  /** This month's last 10 runs, newest first. */
  runs: UsageRun[];
}

// ── Agent runs (backend/geniuscut/agent.py) ──

export interface AgentToolCall { id: string; name: string; input: any }

export interface AgentToolResult { tool_use_id: string; content: string; is_error: boolean }

/** A graphic made in the run, its newest version: the preview PNG and the MOV are absolute paths (spaces and all). */
export interface AgentGraphic { slug: string; version: number; preview: string; path: string; duration_s: number }

/** One model step. tool_calls: run them and post the results; plan: show Go / Cancel; done / stopped: the run is closed. */
export interface AgentStep {
  run_id: string;
  state: "tool_calls" | "plan" | "done" | "stopped";
  tool_calls: AgentToolCall[];
  text: string;
  /** "stopped" only; for "limit", the exact limit message. */
  message: string | null;
  reason: "limit" | "key" | "error" | "refusal" | "max_tokens" | "step_cap" | "graphics" | "cancelled" | null;
  /** usd: this run's total so far. */
  cost: RunCost | null;
  /** The newest version of every graphic made in this run (absent from backends before graphics). */
  graphics?: AgentGraphic[];
}

/** The graphics fields are optional (make_graphic refuses without them): app.project.path, the sequence's timebase
 *  (ticks per frame) and frame size, from the host's gcutGraphicsContext. */
export interface AgentStart {
  instruction: string; selection: unknown; sequence: unknown;
  projectPath?: string; timebase?: string; width?: number; height?: number;
}

/** `GET /graphics/status` (backend/geniuscut/graphics.py): what a render needs, and the one-time setup job. */
export interface GraphicsStatus {
  ready: boolean;
  message: string;
  node: { ok: boolean; path: string | null; version: string | null };
  cli: { ok: boolean; path: string | null; version: string | null };
  chrome: { ok: boolean; path: string | null };
  ffmpeg: { ok: boolean; path: string | null };
  setup: LoginStatus;
}
