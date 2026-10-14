/**
 * The Setup page's steps (spec "Setup page"): gcloud → Sign in → Project → Secret → Test → Monthly
 * limit. A small controller over the backend's setup routes, so the screen stays a view and the
 * logic is tested without a DOM. Settings' "AI key" tab reuses it for the same fields.
 */
import type { Backend } from "../api/backend";
import type { Mode } from "./mode";
import type { GcloudStatus, GcpProject, KeySource, LoginStatus, SecretVersion } from "../api/types";

export type SetupApi = Pick<Backend, "settings" | "saveSettings" | "testKey" | "gcloud" | "startLogin" | "loginStatus" |
  "projects" | "secrets" | "versions">;

/** Live mode opens on Setup until the backend says setup is complete (null: not read yet). Sample data never gates. */
export function setupGate(mode: Mode, setupComplete: boolean | null): "checking" | "setup" | "open" {
  if (mode !== "live") return "open";
  if (setupComplete === null) return "checking";
  return setupComplete ? "open" : "setup";
}

export const INSTALL_URL = "https://cloud.google.com/sdk/docs/install";

// The backend's patterns (settings.py): every value is checked here first, and there again.
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const SECRET = /^(?!-)[A-Za-z0-9_-]{1,255}$/;
const VERSION = /^(latest|[0-9]+)$/;
export const PROJECT_HELP = "Enter the Google Cloud project ID that holds your Anthropic key.";

export const validProject = (p: string) => PROJECT.test(p);
const validSource = (s: KeySource) => PROJECT.test(s.project) && SECRET.test(s.secret) && VERSION.test(s.version);

export interface Listing<T> { items: T[] | null; loading: boolean; error: string | null }
const EMPTY: Listing<never> = { items: null, loading: false, error: null };

export interface SetupState {
  gcloud: GcloudStatus | null;
  checking: boolean;
  gcloudError: string | null;
  login: LoginStatus;
  projects: Listing<GcpProject>;
  query: string;
  /** The chosen project ("" = none yet). */
  project: string;
  projectError: string | null;
  secrets: Listing<string>;
  secret: string;
  versions: Listing<SecretVersion>;
  version: string;
  test: { state: "idle" | "running" | "ok" | "failed"; message: string; source: KeySource | null };
  limit: 20 | 100;
  finishing: boolean;
  finishError: string | null;
}

export type StepId = "gcloud" | "signin" | "project" | "secret" | "test" | "limit";
export interface Step { id: StepId; title: string; status: "done" | "current" | "todo" }

const TITLES: Record<StepId, string> = {
  gcloud: "Google Cloud CLI", signin: "Sign in", project: "Project", secret: "Secret", test: "Test", limit: "Monthly limit",
};

export const source = (s: SetupState): KeySource => ({ project: s.project, secret: s.secret, version: s.version });

const same = (a: KeySource | null, b: KeySource) => !!a && a.project === b.project && a.secret === b.secret && a.version === b.version;

/** The key test passed for exactly the source chosen now. */
export const tested = (s: SetupState): boolean => s.test.state === "ok" && same(s.test.source, source(s));

/** Each step's status: done ones, then the first not done is current, the rest wait. */
export function steps(s: SetupState): Step[] {
  const done: Record<StepId, boolean> = {
    gcloud: !!s.gcloud?.installed,
    signin: !!s.gcloud?.account,
    project: validProject(s.project),
    secret: SECRET.test(s.secret) && VERSION.test(s.version),
    test: tested(s),
    limit: false,
  };
  let current = false;
  return (Object.keys(TITLES) as StepId[]).map((id) => {
    let status: Step["status"] = "todo";
    if (!current && done[id]) status = "done";
    else if (!current) { status = "current"; current = true; }
    return { id, title: TITLES[id], status };
  });
}

export function filterProjects(list: GcpProject[], query: string): GcpProject[] {
  const q = query.trim().toLowerCase();
  return q ? list.filter((p) => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)) : list;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function initialSetup(): SetupState {
  return {
    gcloud: null, checking: false, gcloudError: null, login: { state: "idle", message: "" },
    projects: EMPTY, query: "", project: "", projectError: null,
    secrets: EMPTY, secret: "ANTHROPIC_API_KEY", versions: EMPTY, version: "latest",
    test: { state: "idle", message: "", source: null }, limit: 20, finishing: false, finishError: null,
  };
}

export type Setup = ReturnType<typeof createSetup>;

export function createSetup(api: SetupApi, opts: {
  onChange?: (s: SetupState) => void;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /** The backend kills a login after 5 minutes; stop polling a little after that. */
  maxPolls?: number;
} = {}) {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 2000, maxPolls = opts.maxPolls ?? 170;
  let state = initialSetup(), stopped = false;
  const set = (patch: Partial<SetupState>) => {
    state = { ...state, ...patch };
    if (!stopped) opts.onChange?.(state);
  };

  async function listing<T>(key: "projects" | "secrets" | "versions", fetch: () => Promise<T[]>, still: () => boolean) {
    set({ [key]: { items: state[key].items, loading: true, error: null } } as Partial<SetupState>);
    try {
      const items = await fetch();
      if (still()) set({ [key]: { items, loading: false, error: null } } as Partial<SetupState>);
    } catch (e) {
      if (still()) set({ [key]: { items: null, loading: false, error: msg(e) } } as Partial<SetupState>);
    }
  }

  async function loadVersions() {
    const { project, secret } = state;
    if (!validProject(project) || !SECRET.test(secret)) return set({ versions: EMPTY });
    await listing("versions", async () => (await api.versions(project, secret)).versions,
      () => state.project === project && state.secret === secret);
  }

  async function loadSecrets() {
    const { project } = state;
    await listing("secrets", async () => (await api.secrets(project)).secrets, () => state.project === project);
  }

  const self = {
    get state() { return state; },
    stop() { stopped = true; },

    /** Prefill from the saved settings, then check gcloud (which lists what it can). */
    async start() {
      try {
        const saved = await api.settings();
        set({ project: saved.anthropic_key.project, secret: saved.anthropic_key.secret || state.secret,
              version: saved.anthropic_key.version || state.version, limit: saved.monthly_limit_usd, query: saved.anthropic_key.project });
      } catch { /* defaults */ }
      await self.check();
    },

    async check() {
      set({ checking: true, gcloudError: null });
      try {
        set({ gcloud: await api.gcloud(), checking: false });
      } catch (e) {
        return set({ checking: false, gcloudError: msg(e) });
      }
      if (!state.gcloud?.account) return;
      const loads: Promise<unknown>[] = [self.loadProjects()];
      if (validProject(state.project)) loads.push(loadSecrets(), loadVersions());
      await Promise.all(loads);
    },

    /** gcloud auth login on the backend: the browser opens and the editor signs in there. */
    async signIn() {
      set({ login: { state: "running", message: "Opening Google sign-in in your browser…" } });
      try {
        await api.startLogin();
      } catch (e) {
        // 409: a sign-in is already running, so wait for that one.
        if (!(e && typeof e === "object" && (e as { status?: number }).status === 409)) {
          return set({ login: { state: "failed", message: msg(e) } });
        }
      }
      for (let i = 0; i < maxPolls && !stopped; i++) {
        let now: LoginStatus;
        try {
          now = await api.loginStatus();
        } catch (e) {
          return set({ login: { state: "failed", message: msg(e) } });
        }
        if (now.state !== "running") {
          set({ login: now });
          if (now.state === "done") await self.check();
          return;
        }
        await sleep(pollMs);
      }
    },

    loadProjects: () => listing("projects", async () => (await api.projects()).projects, () => true),

    setQuery(query: string) { set({ query, projectError: null }); },

    async chooseProject(id: string) {
      const project = id.trim();
      if (!validProject(project)) return set({ projectError: PROJECT_HELP });
      set({ project, query: project, projectError: null, secrets: EMPTY, versions: EMPTY });
      await Promise.all([loadSecrets(), loadVersions()]);
    },

    /** While typing: no listing until chooseSecret (on leaving the field, or picking one). */
    setSecret(secret: string) { set({ secret }); },

    async chooseSecret(secret: string) {
      set({ secret: secret.trim() });
      await loadVersions();
    },

    async chooseVersion(version: string) { set({ version }); },

    async test() {
      const src = source(state);
      if (!validSource(src)) return set({ test: { state: "failed", message: PROJECT_HELP, source: src } });
      set({ test: { state: "running", message: "Reading your key and checking it with Anthropic…", source: src } });
      try {
        const r = await api.testKey(src);
        set({ test: { state: r.ok ? "ok" : "failed", message: r.message, source: src } });
      } catch (e) {
        set({ test: { state: "failed", message: msg(e), source: src } });
      }
    },

    setLimit(limit: 20 | 100) { set({ limit }); },

    /** Save the tested source with the chosen limit. False (nothing saved) before a passing test. */
    async finish(): Promise<boolean> {
      if (!tested(state)) return false;
      set({ finishing: true, finishError: null });
      try {
        await api.saveSettings({ anthropic_key: state.test.source!, monthly_limit_usd: state.limit, setup_complete: true });
        set({ finishing: false });
        return true;
      } catch (e) {
        set({ finishing: false, finishError: msg(e) });
        return false;
      }
    },
  };
  return self;
}
