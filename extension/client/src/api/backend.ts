/**
 * Typed client for the local backend. The transport is injected: inside Premiere it's
 * Node's http module (CEP --enable-nodejs), so CORS never applies; in a browser it's the
 * sample-data mock.
 */
import type {
  AgentStart, AgentStep, AgentToolResult, GcloudStatus, GcpProject, Health, KeySource, KeyTest, Library, LoginStatus, RunCost, SecretVersion, Settings, StyleExample,
  TranscriptJob, TranscriptRequest, TrimRequest, TrimResponse, Usage, Word,
} from "./types";

type Method = "GET" | "POST" | "PUT" | "DELETE";

export interface TransportRequest {
  method: Method;
  path: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}
export type Transport = (req: TransportRequest) => Promise<{ status: number; body: string }>;

export class BackendError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "BackendError";
  }
}

function detailOf(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const d = parsed?.detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d)) return d.map((x) => String(x?.msg ?? x).replace(/^Value error, /, "")).join("; ");
  } catch { /* not JSON */ }
  return body.trim() || "No response body";
}

/** Longer than the backend's own 60 s gcloud timeout, so its error message gets through. */
const GCLOUD_MS = 90_000;
/** One agent step (spec: panel HTTP timeout per step 5 min). */
const STEP_MS = 5 * 60_000;

export function createBackend({ transport, token }: { transport: Transport; token: () => string }) {
  async function call<T>(method: Method, path: string, opts: { auth?: boolean; body?: unknown; timeoutMs?: number } = {}) {
    const headers: Record<string, string> = {};
    if (opts.auth !== false) headers.Authorization = `Bearer ${token()}`;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const res = await transport({ method, path, headers, body, timeoutMs: opts.timeoutMs });
    if (res.status < 200 || res.status >= 300) throw new BackendError(detailOf(res.body), res.status);
    return JSON.parse(res.body) as T;
  }

  return {
    health: () => call<Health>("GET", "/health", { auth: false, timeoutMs: 2000 }),
    // 2 hours: a 90-minute clip takes ~12 min on the GPU and far longer if it falls back to the CPU.
    // runId: the agent run that handed this trim over (propose_filler_cuts); its spend rows carry that run's id.
    trim: (req: TrimRequest, runId?: string) =>
      call<TrimResponse>("POST", "/trim", { body: runId ? { ...req, run_id: runId } : req, timeoutMs: 2 * 60 * 60_000 }),
    library: () => call<Library>("GET", "/library"),
    addExample: (raw_words: Word[], final_text: string, source_clip: string) =>
      call<StyleExample>("POST", "/library/examples", { body: { raw_words, final_text, source_clip } }),
    summarize: () => call<{ summary: string; cost?: RunCost | null }>("POST", "/library/summarize", { timeoutMs: 5 * 60_000 }),
    reload: () => call<{ status: string }>("POST", "/reload", { timeoutMs: 2000 }),
    // The assistant's transcripts: cached words, or a job to long-poll (the backend holds a GET up to `waitS`, at most 60 s).
    transcript: (req: TranscriptRequest) => call<TranscriptJob>("POST", "/transcript", { body: req, timeoutMs: 30_000 }),
    transcriptJob: (id: string, waitS: number) =>
      call<TranscriptJob>("GET", `/transcript/${encodeURIComponent(id)}?wait=${waitS}`, { timeoutMs: (waitS + 30) * 1000 }),

    // The Setup page and Settings. gcloud calls have a 60 s timeout on the backend; the key test
    // reads the secret through gcloud, then makes one Anthropic call.
    settings: () => call<Settings>("GET", "/settings"),
    saveSettings: (s: Settings) => call<Settings>("PUT", "/settings", { body: s }),
    testKey: (anthropic_key: KeySource) => call<KeyTest>("POST", "/settings/test-key", { body: { anthropic_key }, timeoutMs: GCLOUD_MS * 2 }),
    gcloud: () => call<GcloudStatus>("GET", "/setup/gcloud", { timeoutMs: GCLOUD_MS }),
    startLogin: () => call<LoginStatus>("POST", "/setup/login", { timeoutMs: GCLOUD_MS }),
    loginStatus: () => call<LoginStatus>("GET", "/setup/login"),
    projects: () => call<{ projects: GcpProject[] }>("GET", "/setup/projects", { timeoutMs: GCLOUD_MS }),
    secrets: (project: string) =>
      call<{ secrets: string[] }>("GET", `/setup/secrets?project=${encodeURIComponent(project)}`, { timeoutMs: GCLOUD_MS }),
    versions: (project: string, secret: string) => call<{ versions: SecretVersion[] }>("GET",
      `/setup/versions?project=${encodeURIComponent(project)}&secret=${encodeURIComponent(secret)}`, { timeoutMs: GCLOUD_MS }),
    usage: () => call<Usage>("GET", "/usage"),

    // Agent runs: each call is one Claude step (5 minutes at most). An unknown run is a 404.
    agentStart: (body: AgentStart) => call<AgentStep>("POST", "/agent/runs", { body, timeoutMs: STEP_MS }),
    agentResults: (runId: string, results: AgentToolResult[]) =>
      call<AgentStep>("POST", `/agent/runs/${encodeURIComponent(runId)}/results`, { body: { results }, timeoutMs: STEP_MS }),
    agentApprove: (runId: string) => call<AgentStep>("POST", `/agent/runs/${encodeURIComponent(runId)}/approve`, { timeoutMs: STEP_MS }),
    agentCancel: (runId: string) => call<{ ok: boolean }>("DELETE", `/agent/runs/${encodeURIComponent(runId)}`, { timeoutMs: 10_000 }),
  };
}

export type Backend = ReturnType<typeof createBackend>;
