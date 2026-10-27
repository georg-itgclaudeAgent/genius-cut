import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SetupView } from "./Setup";
import { GraphicsView, KeyTab, UsageView, resetLine, runGraphicsSetup, runLine } from "./Settings";
import { initialSetup, INSTALL_URL, type Setup, type SetupState } from "../lib/setup";
import type { GraphicsStatus, Usage } from "../api/types";
import { BackendError } from "../api/backend";

const noop = async () => {};
const actions = (): Setup => ({
  state: initialSetup(), stop() {}, start: noop, check: noop, signIn: noop, loadProjects: noop, setQuery() {}, chooseProject: noop,
  setSecret() {}, chooseSecret: noop, chooseVersion: noop, test: noop, setLimit() {}, finish: async () => true,
});
const SIGNED_IN = { installed: true, path: "C:/gcloud.cmd", version: "520.0.0", account: "ed@itgenius.com" };
const view = (s: Partial<SetupState>) =>
  renderToStaticMarkup(<SetupView s={{ ...initialSetup(), ...s }} setup={actions()} onFinish={() => {}} openUrl={() => {}} />);

describe("Setup page", () => {
  it("without gcloud: says to install the Google Cloud CLI with the official link, and Check again", () => {
    const html = view({ gcloud: { installed: false, path: null, version: null, account: null } });
    expect(html).toContain("Install the Google Cloud CLI");
    expect(html).toContain(INSTALL_URL);
    expect(html).toContain("Check again");
    expect(html).not.toContain("Sign in with Google");
  });

  it("installed, nobody signed in: offers Sign in with Google and says the browser opens", () => {
    const html = view({ gcloud: { ...SIGNED_IN, account: null } });
    expect(html).toContain("Installed · 520.0.0");
    expect(html).toMatch(/<button[^>]*>Sign in with Google<\/button>/);
    expect(html).toContain("never sees your password");
  });

  it("while the sign-in runs, the button waits and says where to finish", () => {
    const html = view({ gcloud: { ...SIGNED_IN, account: null }, login: { state: "running", message: "Opening" } });
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Sign in with Google<\/button>/);
    expect(html).toContain("Finish signing in in your browser");
  });

  it("a failed sign-in shows its message", () => {
    const html = view({ gcloud: { ...SIGNED_IN, account: null }, login: { state: "failed", message: "The sign-in timed out after 5 minutes." } });
    expect(html).toContain("The sign-in timed out after 5 minutes.");
  });

  it("signed in: the account, a project search with the listed projects, and type-in of an id", () => {
    const html = view({ gcloud: SIGNED_IN, query: "editor-ai-2",
      projects: { items: [{ id: "agent-georg", name: "Agent Georg" }, { id: "editor-ai", name: "Editor AI" }], loading: false, error: null } });
    expect(html).toContain("Signed in as ed@itgenius.com");
    expect(html).toContain('placeholder="Search, or type a project ID"');
    // The search filters the list; an id that isn't listed can be used as typed.
    expect(html).toContain("Use editor-ai-2");
    expect(html).not.toContain("Agent Georg");
  });

  it("a project chosen: secret (with its listed names) and version pickers, latest first", () => {
    const html = view({ gcloud: SIGNED_IN, project: "editor-ai", query: "editor-ai",
      projects: { items: [], loading: false, error: null },
      secrets: { items: ["ANTHROPIC_API_KEY", "OTHER"], loading: false, error: null },
      versions: { items: [{ version: "3", state: "enabled" }, { version: "2", state: "disabled" }], loading: false, error: null } });
    expect(html).toContain('value="ANTHROPIC_API_KEY"');
    expect(html).toContain('<option value="OTHER">');
    expect(html).toMatch(/<select[^>]*>.*<option value="latest"[^>]*>latest<\/option><option value="3">3<\/option><\/select>/);
    expect(html).not.toContain('<option value="2">');
    expect(html).toMatch(/<button[^>]*>Test<\/button>/);
  });

  it("a listing error shows gcloud's message", () => {
    const html = view({ gcloud: SIGNED_IN, project: "editor-ai", projects: { items: [], loading: false, error: null },
      secrets: { items: null, loading: false, error: "Permission denied on project editor-ai." } });
    expect(html).toContain("Permission denied on project editor-ai.");
  });

  it("a failed test shows the backend's message; a pass opens the limit choice and Finish", () => {
    const base = { gcloud: SIGNED_IN, project: "editor-ai", projects: { items: [], loading: false, error: null } };
    const src = { project: "editor-ai", secret: "ANTHROPIC_API_KEY", version: "latest" };
    const failed = view({ ...base, test: { state: "failed", message: "Anthropic rejected the API key in secret X.", source: src } });
    expect(failed).toMatch(/class="note bad"[^>]*>Anthropic rejected the API key in secret X\./);
    expect(failed).not.toContain("Finish");
    const ok = view({ ...base, test: { state: "ok", message: "Connected: the API key works.", source: src } });
    expect(ok).toContain("Connected: the API key works.");
    expect(ok).toMatch(/aria-pressed="true"[^>]*>\$20/);
    expect(ok).toContain("$100");
    expect(ok).toMatch(/<button[^>]*>Finish<\/button>/);
  });
});

describe("Settings: AI key tab", () => {
  const tab = (s: Partial<SetupState>, fromCache: boolean) => renderToStaticMarkup(
    <KeyTab s={{ ...initialSetup(), gcloud: SIGNED_IN, project: "editor-ai", projects: { items: [], loading: false, error: null }, ...s }}
      setup={actions()} keyFromCache={fromCache} />);

  it("has the same fields and a re-test", () => {
    const html = tab({}, false);
    expect(html).toContain('placeholder="Search, or type a project ID"');
    expect(html).toContain('value="ANTHROPIC_API_KEY"');
    expect(html).toMatch(/<button[^>]*>Test and save<\/button>/);
    expect(html).not.toContain("saved copy");
  });

  it("says when the cached key is in use because the gcloud login expired, with Sign in again", () => {
    const html = tab({}, true);
    expect(html).toContain("saved copy of your key");
    expect(html).toMatch(/<button[^>]*>Sign in with Google<\/button>/);
  });
});

describe("Settings: Graphics (AI key tab)", () => {
  const READY: GraphicsStatus = { ready: true, message: "Graphics are set up (HyperFrames 0.8.181).",
    node: { ok: true, path: "C:/Program Files/nodejs/node.exe", version: "24.1.0" },
    cli: { ok: true, path: "C:/x/hyperframes.mjs", version: "0.8.181" }, chrome: { ok: true, path: "C:/x/chrome.exe" },
    ffmpeg: { ok: true, path: "C:/ffmpeg/bin/ffmpeg.exe" }, setup: { state: "idle", message: "" } };
  const NOT_SET: GraphicsStatus = { ...READY, ready: false, message: "Graphics aren't set up yet.",
    cli: { ok: false, path: null, version: null }, chrome: { ok: false, path: null } };
  const view = (status: GraphicsStatus | null, o: { busy?: boolean; error?: string | null } = {}) => renderToStaticMarkup(
    <GraphicsView status={status} busy={o.busy ?? false} error={o.error ?? null} onSetup={() => {}} />);

  it("shows a status line for Node.js, HyperFrames, Chrome and FFmpeg, and the backend's message", () => {
    const html = view(READY);
    expect(html).toContain("Graphics");
    expect(html).toContain("Graphics are set up (HyperFrames 0.8.181).");
    for (const t of ["Node.js", "24.1.0", "HyperFrames", "0.8.181", "Chrome", "FFmpeg"]) expect(html).toContain(t);
    expect(html.match(/class="pip ok"/g)).toHaveLength(4);
    expect(html).not.toMatch(/<button[^>]*>Set up graphics<\/button>/);
  });

  it("not set up: the missing parts are marked and Set up graphics is offered", () => {
    const html = view(NOT_SET);
    expect(html.match(/class="pip bad"/g)).toHaveLength(2);
    expect(html).toMatch(/<button[^>]*>Set up graphics<\/button>/);
  });

  it("while the setup runs: its progress, and the button is disabled", () => {
    const html = view({ ...NOT_SET, setup: { state: "running", message: "Installing HyperFrames…" } }, { busy: true });
    expect(html).toContain("Installing HyperFrames…");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Setting up…<\/button>/);
  });

  it("a failed setup or status read shows its message", () => {
    expect(view({ ...NOT_SET, setup: { state: "failed", message: "npm install failed" } })).toMatch(/class="note bad"[^>]*>npm install failed/);
    expect(view(null, { error: "Backend unreachable" })).toMatch(/class="note bad"[^>]*>Backend unreachable/);
  });

  it("Set up graphics POSTs the setup, then polls the status every 2 s until the setup is no longer running", async () => {
    const seen: string[] = [], slept: number[] = [], shown: GraphicsStatus[] = [];
    const states = ["running", "running", "done"] as const;
    const api = {
      graphicsSetup: async () => { seen.push("setup"); return { state: "running", message: "Starting" }; },
      graphicsStatus: async () => { seen.push("status"); const st = states[Math.min(seen.length - 2, 2)];
        return { ...(st === "done" ? READY : NOT_SET), setup: { state: st, message: st } }; },
    };
    const last = await runGraphicsSetup(api, (st) => shown.push(st), async (ms) => { slept.push(ms); });
    expect(seen).toEqual(["setup", "status", "status", "status"]);
    expect(slept).toEqual([2000, 2000, 2000]);
    expect(shown.map((x) => x.setup.state)).toEqual(["running", "running", "done"]);
    expect(last.ready).toBe(true);
  });

  it("a setup already running (409) is polled, not an error", async () => {
    const api = {
      graphicsSetup: async (): Promise<{ state: string; message: string }> => { throw new BackendError("Graphics setup is already running.", 409); },
      graphicsStatus: async () => ({ ...READY, setup: { state: "done" as const, message: "" } }),
    };
    expect((await runGraphicsSetup(api, () => {}, async () => {})).ready).toBe(true);
  });
});

describe("Settings: Usage & limit tab", () => {
  const USAGE: Usage = { month_usd: 4.5, limit_usd: 20, limit_tier: 20, resets_on: "2026-11-01", run_count: 12, runs: [
    { at: "2026-10-14T05:00:00+00:00", kind: "agent", model: "anthropic:claude-opus-5-5", label: "Claude Opus 5.5 (Anthropic)", provider: "anthropic", usd: 0.42 },
    { at: "2026-10-13T05:00:00+00:00", kind: "trim", model: "vertex:claude-opus-5-5", label: "Claude Opus 5.5 (Google Cloud)", provider: "vertex", usd: null },
  ] };
  const usage = (u: Usage, tier: 20 | 100 = 20) => renderToStaticMarkup(<UsageView usage={u} tier={tier} saving={false} error={null} onTier={() => {}} />);

  it("shows the month against the limit with a bar, the runs and the last ones, the limit choice and the reset date", () => {
    const html = usage(USAGE);
    expect(html).toContain("$4.50 of $20.00");
    expect(html).toMatch(/class="meter[^"]*"[^>]*role="meter"/);
    expect(html).toContain("width:22.5%");
    expect(html).toContain("12 runs this month");
    expect(html).toContain("Instruction");
    expect(html).toContain("Instruction · Claude Opus 5.5 (Anthropic)");
    expect(html).toContain("Trim · Claude Opus 5.5 (Google Cloud)");
    expect(html).toMatch(/class="pv">Anthropic</);
    expect(html).toMatch(/class="pv">Google Cloud</);
    expect(html).toContain("Anthropic&#x27;s console and Google Cloud billing are the bills of record");
    expect(html).toContain("$0.42");
    expect(html).toContain("cost unknown");
    expect(html).toMatch(/aria-pressed="true"[^>]*>\$20/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>\$100/);
    expect(html).toContain("Resets on 1 November 2026");
  });

  it("with the $100 limit on, that one is pressed", () => {
    expect(usage({ ...USAGE, limit_usd: 100, limit_tier: 100 }, 100)).toMatch(/aria-pressed="true"[^>]*>\$100/);
  });

  it("formats the reset day and a run line", () => {
    expect(resetLine("2027-01-01")).toBe("Resets on 1 January 2027");
    expect(runLine({ at: "2026-10-14T05:00:00+00:00", kind: "summarize", model: "gemini:gemini-3.7-flash", label: "Gemini 3.7 Flash", provider: "gemini", usd: 0.004 }))
      .toEqual({ when: expect.stringMatching(/14 Oct/), what: "Style summary · Gemini 3.7 Flash", provider: "Gemini API", usd: "<$0.01" });
  });
});

describe("sample data (preview / browser)", () => {
  it("answers the settings, usage and setup routes, so the gear works without a backend", async () => {
    const { mockTransport } = await import("../api/mock");
    const { createBackend } = await import("../api/backend");
    const api = createBackend({ transport: mockTransport, token: () => "sample" });
    expect((await api.settings()).setup_complete).toBe(true);
    expect((await api.usage()).limit_tier).toBe(20);
    expect((await api.projects()).projects.length).toBeGreaterThan(0);
    const saved = await api.saveSettings({ ...(await api.settings()), monthly_limit_usd: 100 });
    expect((await api.usage()).limit_usd).toBe(100);
    await api.saveSettings({ ...saved, monthly_limit_usd: 20 });
    expect((await api.graphicsStatus()).ready).toBe(false);
    expect((await api.graphicsSetup()).state).toBe("running");
  });
});
