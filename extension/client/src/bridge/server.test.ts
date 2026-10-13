import { afterEach, describe, it, expect, vi } from "vitest";
import { createRequire } from "module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startAssistant, startBridge, type Bridge } from "./server";
import type { ToolTable } from "./tools";

const nodeRequire = createRequire(import.meta.url);
const dirs: string[] = [], bridges: Bridge[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "gcut-bridge-")); dirs.push(d); return join(d, "itGenius", "genius-cut"); };
afterEach(async () => {
  for (const b of bridges.splice(0)) await b.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TOKEN = "t".repeat(64);
async function bridge(tools: ToolTable, opts: { busy?: () => boolean; dir?: string; token?: string } = {}) {
  const dir = opts.dir ?? tempDir();
  const b = await startBridge({ http: nodeRequire("http"), fs: nodeRequire("fs"), path: nodeRequire("path"), dir, pid: 4242,
    panelVersion: "0.1.0", token: opts.token ?? TOKEN, tools, busy: opts.busy ?? (() => false) });
  bridges.push(b);
  return { b, dir, url: `http://127.0.0.1:${b.port}` };
}
const call = (url: string, body: unknown, token: string | null = TOKEN) => fetch(`${url}/tool`, {
  method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

const echo: ToolTable = {
  get_sequence: { kind: "read", run: async (args) => ({ read: args }) },
  add_markers: { kind: "act", run: async (args) => ({ acted: args }) },
  cut_ranges: { kind: "act", run: async () => { throw new Error("V2 is locked. Unlock it to apply."); } },
};

describe("the bridge server", () => {
  it("writes bridge.json {port, token, pid, panelVersion} after it listens on 127.0.0.1, and deletes it on stop", async () => {
    const { b, dir } = await bridge(echo);
    const file = join(dir, "bridge.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ port: b.port, token: TOKEN, pid: 4242, panelVersion: "0.1.0" });
    expect(b.port).toBeGreaterThan(0);
    await b.stop();
    expect(existsSync(file)).toBe(false);
  });

  it("on stop, leaves a bridge.json another panel has written since", async () => {
    const dir = tempDir();
    const first = await bridge(echo, { dir }), second = await bridge(echo, { dir, token: "s".repeat(64) });
    await first.b.stop();
    expect(JSON.parse(readFileSync(join(dir, "bridge.json"), "utf8")).port).toBe(second.b.port);
  });

  it("answers GET /ping without a token, marked with the bridge header", async () => {
    const { url } = await bridge(echo);
    const r = await fetch(`${url}/ping`);
    expect(r.status).toBe(200);
    expect(r.headers.get("x-genius-cut")).toBe("gcut-assistant-bridge");
    expect(await r.json()).toEqual({ ok: true, panelVersion: "0.1.0" });
  });

  it("routes POST /tool {name, args, client} to the tool and replies {ok, result}", async () => {
    const { url } = await bridge(echo);
    const r = await call(url, { name: "get_sequence", args: { fromS: 1 }, client: "terminal" });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-genius-cut")).toBe("gcut-assistant-bridge");
    expect(await r.json()).toEqual({ ok: true, result: { read: { fromS: 1 } } });
  });

  it("replies {ok: false, message} when the tool refuses, and for an unknown tool", async () => {
    const { url } = await bridge(echo);
    expect(await (await call(url, { name: "cut_ranges", args: {}, client: "terminal" })).json())
      .toEqual({ ok: false, message: "V2 is locked. Unlock it to apply." });
    expect(await (await call(url, { name: "rm_rf", args: {}, client: "terminal" })).json())
      .toEqual({ ok: false, message: "Unknown tool rm_rf." });
  });

  it("refuses a missing or wrong token with 401, running nothing", async () => {
    const run = vi.fn(async () => "ran");
    const { url } = await bridge({ add_markers: { kind: "act", run } });
    for (const token of [null, "wrong"]) {
      const r = await call(url, { name: "add_markers", args: {}, client: "terminal" }, token);
      expect(r.status).toBe(401);
      expect(r.headers.get("x-genius-cut")).toBe("gcut-assistant-bridge");
      expect(await r.json()).toMatchObject({ ok: false, message: expect.any(String) });
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a body that isn't JSON", async () => {
    const { url } = await bridge(echo);
    const r = await fetch(`${url}/tool`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: "{nope" });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ ok: false });
  });

  it("runs one call at a time: the next waits until the one before has finished", async () => {
    const order: string[] = [];
    let release!: () => void;
    const slow: ToolTable = {
      get_sequence: { kind: "read", run: async () => { order.push("slow start"); await new Promise<void>((r) => { release = r; }); order.push("slow end"); return 1; } },
      add_markers: { kind: "act", run: async () => { order.push("next"); return 2; } },
    };
    const { url } = await bridge(slow);
    const a = call(url, { name: "get_sequence", args: {}, client: "terminal" });
    await vi.waitFor(() => expect(order).toEqual(["slow start"]));
    const b = call(url, { name: "add_markers", args: {}, client: "terminal" });
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual(["slow start"]);
    release();
    expect(await (await a).json()).toEqual({ ok: true, result: 1 });
    expect(await (await b).json()).toEqual({ ok: true, result: 2 });
    expect(order).toEqual(["slow start", "slow end", "next"]);
  });

  it("refuses act tools while the Cut tab is busy (Analyse, Apply, Restore or Close gap); read tools still run", async () => {
    const act = vi.fn(async () => "acted");
    const { url } = await bridge({ ...echo, add_markers: { kind: "act", run: act } }, { busy: () => true });
    const r = await (await call(url, { name: "add_markers", args: {}, client: "terminal" })).json();
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/Genius Cut is busy/) });
    expect(act).not.toHaveBeenCalled();
    expect(await (await call(url, { name: "get_sequence", args: {}, client: "terminal" })).json()).toMatchObject({ ok: true });
  });
});

describe("startAssistant: only in a flagged build, live in Premiere", () => {
  function deps(flag: string | undefined, mode: "live" | "preview" | "browser", evalOut = "ok") {
    const dir = tempDir();
    const evalScript = vi.fn(async (_s: string) => evalOut);
    return { dir, evalScript, d: {
      flag, mode, evalScript, node: (id: string) => nodeRequire(id), extensionRoot: () => "C:/ext/genius-cut", dataDir: () => dir,
      backend: { transcript: vi.fn(), transcriptJob: vi.fn() }, busy: () => false, panelVersion: "0.1.0" } };
  }

  it.each([[undefined, "live"], ["0", "live"], ["1", "preview"], ["1", "browser"]] as const)(
    "flag %s in %s mode: no bridge, no host script, no bridge.json", async (flag, mode) => {
      const x = deps(flag, mode);
      expect(await startAssistant(x.d)).toBeNull();
      expect(x.evalScript).not.toHaveBeenCalled();
      expect(existsSync(join(x.dir, "bridge.json"))).toBe(false);
    });

  it("flagged and live: loads host/assistant.jsx with $.evalFile first, then serves with a fresh 32-byte token", async () => {
    const x = deps("1", "live");
    const b = (await startAssistant(x.d))!;
    bridges.push(b);
    expect(x.evalScript.mock.calls[0][0]).toContain('$.evalFile(new File("C:/ext/genius-cut/host/assistant.jsx"))');
    const info = JSON.parse(readFileSync(join(x.dir, "bridge.json"), "utf8"));
    expect(info).toMatchObject({ port: b.port, pid: process.pid, panelVersion: "0.1.0" });
    expect(info.token).toMatch(/^[0-9a-f]{64}$/);
    expect((await fetch(`http://127.0.0.1:${b.port}/ping`)).status).toBe(200);
  });

  it("doesn't serve when the assistant's host script fails to load", async () => {
    const x = deps("1", "live", "Error: syntax error");
    await expect(startAssistant(x.d)).rejects.toThrow(/syntax error/);
    expect(existsSync(join(x.dir, "bridge.json"))).toBe(false);
  });

  it("loads turns.json on start: undo_last_turn reverses a turn made before the panel reloaded", async () => {
    const x = deps("1", "live");
    const record = { kind: "markers", sequenceId: "seq-1", markers: [{ id: "g1" }] };
    mkdirSync(x.dir, { recursive: true });
    writeFileSync(join(x.dir, "turns.json"), JSON.stringify({ "seq-1": [{ id: "t1", at: "2026-10-14T08:00:00.000Z", sequenceId: "seq-1",
      tool: "add_markers", args: {}, summary: "Added 1 marker: Intro", undo: record }] }));
    x.evalScript.mockImplementation(async (s: string) =>
      s.includes("$.evalFile") ? "ok" : s.includes("gcutToolUndo(") ? JSON.stringify({ ok: true }) : JSON.stringify({ sequenceId: "seq-1", clips: [] }));
    const b = (await startAssistant(x.d))!;
    bridges.push(b);
    const { token } = JSON.parse(readFileSync(join(x.dir, "bridge.json"), "utf8"));
    const r = await fetch(`http://127.0.0.1:${b.port}/tool`, { method: "POST", headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "undo_last_turn", args: {}, client: "terminal" }) });
    expect(await r.json()).toEqual({ ok: true, result: { ok: true, undone: "Added 1 marker: Intro" } });
    const undoScript = x.evalScript.mock.calls.map((c) => c[0]).find((c) => c.includes("gcutToolUndo("))!;
    expect(undoScript).toContain(JSON.stringify(JSON.stringify({ record })));
    expect(JSON.parse(readFileSync(join(x.dir, "turns.json"), "utf8"))["seq-1"]).toEqual([]);
  });
});
