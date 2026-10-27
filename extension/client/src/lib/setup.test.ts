import { describe, it, expect } from "vitest";
import { createSetup, filterProjects, setupGate, steps, tested, type SetupApi } from "./setup";
import { BackendError } from "../api/backend";
import type { GcloudStatus, KeySource, LoginStatus, Settings, SettingsPatch } from "../api/types";

const SIGNED_IN: GcloudStatus = { installed: true, path: "C:/gcloud.cmd", version: "520.0.0", account: "ed@itgenius.com" };
const DEFAULTS: Settings = { anthropic_key: { project: "", secret: "ANTHROPIC_API_KEY", version: "latest" }, monthly_limit_usd: 20,
  setup_complete: false, model: "anthropic:claude-opus-5-5", vertex: { project: "agent-georg", region: "global" } };

function fakeApi(o: { gcloud?: GcloudStatus[]; logins?: LoginStatus[]; settings?: Settings; startLogin?: () => Promise<LoginStatus>;
  test?: (s: KeySource) => { ok: boolean; message: string }; secretsFail?: string } = {}) {
  const calls: string[] = [], saved: SettingsPatch[] = [], tests: KeySource[] = [];
  const gcloud = [...(o.gcloud ?? [SIGNED_IN])], logins = [...(o.logins ?? [{ state: "done", message: "Signed in." }])];
  const api: SetupApi = {
    settings: async () => { calls.push("settings"); return o.settings ?? DEFAULTS; },
    saveSettings: async (s) => { calls.push("save"); saved.push(s); return { ...(o.settings ?? DEFAULTS), ...s } as Settings; },
    testKey: async (s) => { calls.push("test"); tests.push(s); return (o.test ?? (() => ({ ok: true, message: "Connected." })))(s); },
    gcloud: async () => { calls.push("gcloud"); return gcloud.length > 1 ? gcloud.shift()! : gcloud[0]; },
    startLogin: o.startLogin ?? (async () => { calls.push("login"); return { state: "running", message: "Opening the browser." }; }),
    loginStatus: async () => { calls.push("poll"); return logins.length > 1 ? logins.shift()! : logins[0]; },
    projects: async () => { calls.push("projects"); return { projects: [{ id: "agent-georg", name: "Agent Georg" }, { id: "editor-ai", name: "Editor AI" }] }; },
    secrets: async (p) => {
      calls.push(`secrets ${p}`);
      if (o.secretsFail) throw new BackendError(o.secretsFail, 502);
      return { secrets: ["ANTHROPIC_API_KEY", "OTHER"] };
    },
    versions: async (p, s) => { calls.push(`versions ${p} ${s}`); return { versions: [{ version: "3", state: "enabled" }, { version: "2", state: "disabled" }] }; },
  };
  return { api, calls, saved, tests };
}
const noSleep = async () => {};

describe("Setup: the steps", () => {
  it("starts on gcloud: missing → the install step stays current, and the later steps wait", async () => {
    const f = fakeApi({ gcloud: [{ installed: false, path: null, version: null, account: null }] });
    const s = createSetup(f.api, { sleep: noSleep });
    await s.start();
    expect(steps(s.state).map((x) => [x.id, x.status])).toEqual([
      ["gcloud", "current"], ["signin", "todo"], ["project", "todo"], ["secret", "todo"], ["test", "todo"], ["limit", "todo"]]);
    expect(f.calls).not.toContain("projects");
  });

  it("installed but nobody signed in: Sign in is current, and no listing is asked for", async () => {
    const f = fakeApi({ gcloud: [{ ...SIGNED_IN, account: null }] });
    const s = createSetup(f.api, { sleep: noSleep });
    await s.start();
    expect(steps(s.state).find((x) => x.status === "current")!.id).toBe("signin");
    expect(f.calls).not.toContain("projects");
  });

  it("signed in: lists the projects; choosing one lists its secrets and the default secret's versions", async () => {
    const f = fakeApi();
    const s = createSetup(f.api, { sleep: noSleep });
    await s.start();
    expect(s.state.projects.items!.map((p) => p.id)).toEqual(["agent-georg", "editor-ai"]);
    expect(steps(s.state).find((x) => x.status === "current")!.id).toBe("project");
    await s.chooseProject("editor-ai");
    expect(f.calls).toContain("secrets editor-ai");
    expect(f.calls).toContain("versions editor-ai ANTHROPIC_API_KEY");
    expect(s.state.versions.items!.map((v) => v.version)).toEqual(["3", "2"]);
    expect(steps(s.state).find((x) => x.status === "current")!.id).toBe("test");
  });

  it("prefills the saved key source, and loads its listings once signed in", async () => {
    const f = fakeApi({ settings: { ...DEFAULTS, anthropic_key: { project: "agent-georg", secret: "OTHER", version: "2" }, monthly_limit_usd: 100 } });
    const s = createSetup(f.api, { sleep: noSleep });
    await s.start();
    expect([s.state.project, s.state.secret, s.state.version, s.state.limit]).toEqual(["agent-georg", "OTHER", "2", 100]);
    expect(f.calls).toContain("versions agent-georg OTHER");
  });

  it("a typed project id is checked before any gcloud call (cmd.exe passes it on)", async () => {
    const f = fakeApi();
    const s = createSetup(f.api, { sleep: noSleep });
    await s.start();
    await s.chooseProject("x & del C:\\");
    expect(s.state.project).toBe("");
    expect(s.state.projectError).toBe("Enter the Google Cloud project ID that holds your Anthropic key.");
    expect(f.calls.filter((c) => c.startsWith("secrets"))).toEqual([]);
  });

  it("a listing that fails shows gcloud's message; the name can still be typed", async () => {
    const f = fakeApi({ secretsFail: "Secret Manager API has not been used in project editor-ai." });
    const s = createSetup(f.api, { sleep: noSleep });
    await s.start();
    await s.chooseProject("editor-ai");
    expect(s.state.secrets.error).toBe("Secret Manager API has not been used in project editor-ai.");
    await s.chooseSecret("MY_KEY");
    expect(s.state.secret).toBe("MY_KEY");
    expect(f.calls).toContain("versions editor-ai MY_KEY");
  });

  it("Test sends the chosen source; a pass makes Test done and the limit current", async () => {
    const f = fakeApi();
    const s = createSetup(f.api, { sleep: noSleep });
    await s.start();
    await s.chooseProject("editor-ai");
    await s.chooseVersion("3");
    await s.test();
    expect(f.tests).toEqual([{ project: "editor-ai", secret: "ANTHROPIC_API_KEY", version: "3" }]);
    expect(tested(s.state)).toBe(true);
    expect(steps(s.state).map((x) => x.status)).toEqual(["done", "done", "done", "done", "done", "current"]);
  });

  it("a failed test shows the backend's message as it is, and changing the source undoes a pass", async () => {
    const f = fakeApi({ test: (src) => (src.version === "2" ? { ok: false, message: "Anthropic rejected the API key in secret X." } : { ok: true, message: "Connected." }) });
    const s = createSetup(f.api, { sleep: noSleep });
    await s.start();
    await s.chooseProject("editor-ai");
    await s.test();
    expect(tested(s.state)).toBe(true);
    await s.chooseVersion("2");
    expect(tested(s.state)).toBe(false);
    await s.test();
    expect(s.state.test).toMatchObject({ state: "failed", message: "Anthropic rejected the API key in secret X." });
  });

  it("Finish saves the tested source with the limit chosen", async () => {
    const f = fakeApi();
    const s = createSetup(f.api, { sleep: noSleep });
    await s.start();
    await s.chooseProject("editor-ai");
    await s.test();
    s.setLimit(100);
    expect(await s.finish()).toBe(true);
    expect(f.saved).toEqual([{ anthropic_key: { project: "editor-ai", secret: "ANTHROPIC_API_KEY", version: "latest" },
      monthly_limit_usd: 100, setup_complete: true }]);
  });

  it("Finish refuses before a passing test", async () => {
    const f = fakeApi();
    const s = createSetup(f.api, { sleep: noSleep });
    await s.start();
    expect(await s.finish()).toBe(false);
    expect(f.saved).toEqual([]);
  });
});

describe("Setup: Sign in with Google", () => {
  it("starts gcloud auth login, polls until done, then checks gcloud again and lists the projects", async () => {
    const f = fakeApi({ gcloud: [{ ...SIGNED_IN, account: null }, SIGNED_IN],
      logins: [{ state: "running", message: "Waiting" }, { state: "running", message: "Waiting" }, { state: "done", message: "Signed in." }] });
    const s = createSetup(f.api, { sleep: noSleep });
    await s.start();
    await s.signIn();
    expect(f.calls.filter((c) => c === "poll")).toHaveLength(3);
    expect(s.state.login.state).toBe("done");
    expect(s.state.gcloud!.account).toBe("ed@itgenius.com");
    expect(f.calls).toContain("projects");
  });

  it("a login already running (409) is polled, not refused", async () => {
    const f = fakeApi({ gcloud: [{ ...SIGNED_IN, account: null }, SIGNED_IN],
      startLogin: async () => { throw new BackendError("A sign-in is already running.", 409); } });
    const s = createSetup(f.api, { sleep: noSleep });
    await s.start();
    await s.signIn();
    expect(s.state.login.state).toBe("done");
  });

  it("a failed login shows its message and leaves Sign in current", async () => {
    const f = fakeApi({ gcloud: [{ ...SIGNED_IN, account: null }], logins: [{ state: "failed", message: "The sign-in timed out after 5 minutes." }] });
    const s = createSetup(f.api, { sleep: noSleep });
    await s.start();
    await s.signIn();
    expect(s.state.login).toEqual({ state: "failed", message: "The sign-in timed out after 5 minutes." });
    expect(steps(s.state).find((x) => x.status === "current")!.id).toBe("signin");
  });

  it("an error starting the login (gcloud missing) shows as a failed login", async () => {
    const f = fakeApi({ gcloud: [{ ...SIGNED_IN, account: null }],
      startLogin: async () => { throw new BackendError("gcloud is not installed. Install the Google Cloud CLI, then check again.", 502); } });
    const s = createSetup(f.api, { sleep: noSleep });
    await s.start();
    await s.signIn();
    expect(s.state.login).toEqual({ state: "failed", message: "gcloud is not installed. Install the Google Cloud CLI, then check again." });
  });
});

describe("filterProjects", () => {
  const list = [{ id: "agent-georg", name: "Agent Georg" }, { id: "editor-ai", name: "Editor AI" }];
  it("matches id or name, any case; an empty search shows all", () => {
    expect(filterProjects(list, "EDITOR").map((p) => p.id)).toEqual(["editor-ai"]);
    expect(filterProjects(list, "georg").map((p) => p.id)).toEqual(["agent-georg"]);
    expect(filterProjects(list, "  ")).toHaveLength(2);
  });
});

describe("the setup gate", () => {
  it("live: Setup until setup_complete; checking until the settings are read", () => {
    expect(setupGate("live", null)).toBe("checking");
    expect(setupGate("live", false)).toBe("setup");
    expect(setupGate("live", true)).toBe("open");
  });
  it("preview and browser (sample data) never gate", () => {
    expect(setupGate("preview", false)).toBe("open");
    expect(setupGate("browser", null)).toBe("open");
  });
});
