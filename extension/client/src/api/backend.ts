/**
 * Typed client for the local backend. The transport is injected: inside Premiere it's
 * Node's http module (CEP --enable-nodejs), so CORS never applies; in a browser it's the
 * sample-data mock.
 */
import type { Health, Library, StyleExample, TrimRequest, TrimResponse, Word } from "./types";

export interface TransportRequest {
  method: "GET" | "POST";
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

export function createBackend({ transport, token }: { transport: Transport; token: () => string }) {
  async function call<T>(method: "GET" | "POST", path: string, opts: { auth?: boolean; body?: unknown; timeoutMs?: number } = {}) {
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
    trim: (req: TrimRequest) => call<TrimResponse>("POST", "/trim", { body: req, timeoutMs: 10 * 60_000 }),
    library: () => call<Library>("GET", "/library"),
    addExample: (raw_words: Word[], final_text: string, source_clip: string) =>
      call<StyleExample>("POST", "/library/examples", { body: { raw_words, final_text, source_clip } }),
    summarize: () => call<{ summary: string }>("POST", "/library/summarize", { timeoutMs: 5 * 60_000 }),
  };
}

export type Backend = ReturnType<typeof createBackend>;
