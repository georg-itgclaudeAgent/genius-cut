import { describe, it, expect } from "vitest";
import { createAgent, namedInPlan, NOT_APPROVED, type AgentApi } from "./run";
import { createTools } from "../bridge/tools";
import { createTurns, type TurnStore } from "../bridge/turns";
import { BackendError } from "../api/backend";
import type { AgentStep, AgentToolCall, RunCost, Snapshot } from "../api/types";

const TICKS = 254016000000;
const id = (label: string, startS: number, node: string) => `${label}@${Math.round(startS * TICKS)}#${node}`;
const V1 = id("V1", 100, "a"), A1 = id("A1", 100, "m"), OTHER = id("V2", 100, "z");
const P1 = id("V1", 100, "a"), P2 = id("V1", 104, "a");
const clip = (cid: string, track: string, startS: number, endS: number, selected = false) =>
  ({ id: cid, track, name: `${track}.mov`, startS, endS, inS: 0, source: `D:/${track}.mov`, selected, enabled: true, effects: [], speed: 1 });
const BASE = {
  sequenceId: "seq-1", name: "Main", fps: 25, durationS: 200, tracks: [{ kind: "video", index: 1, name: "", muted: false }], markers: [] as any[],
  selection: [V1, A1], clips: [clip(V1, "V1", 100, 110, true), clip(A1, "A1", 100, 110, true), clip(OTHER, "V2", 120, 130)],
};
const COST: RunCost = { model: "claude-opus-5-5", input_tokens: 1000, output_tokens: 200, usd: 0.05, month_usd: 1.2, limit_usd: 20 };
const SNAP = { found: true, sequenceId: "seq-1", startTicks: "0", endTicks: "1", startS: 100, durationS: 10, fps: 25, video: [], audio: [], problems: [] } as Snapshot;

const memoryStore = (): TurnStore => { let text: string | null = null; return { read: () => text, write: (t) => { text = t; } }; };
const call = (name: string, input: any, n = name): AgentToolCall => ({ id: `tu-${n}`, name, input });
const step = (state: AgentStep["state"], extra: Partial<AgentStep> = {}): AgentStep =>
  ({ run_id: "r1", state, tool_calls: [], text: "", message: null, reason: null, cost: COST, ...extra });
const calls = (...c: AgentToolCall[]) => step("tool_calls", { tool_calls: c });

function world(script: { start: AgentStep | (() => AgentStep); [k: string]: any }) {
  let listing: any = structuredClone(BASE);
  const host: [string, any][] = [];
  let undoReply: (record: any) => any = () => ({ ok: true });
  const actReplies: Record<string, (args: any) => any> = {};
  let cutReply: (args: any) => any = () => ({ ok: true, cutCount: 1, clipCount: 1, removedS: 1, crossfades: 0, idMap: {}, undo: { kind: "cuts", sequenceId: "seq-1" } });
  const callHost = async (fn: string, args: any) => {
    host.push([fn, args]);
    if (fn === "gcutToolGetSequence") return structuredClone(listing);
    if (fn === "gcutToolAddMarkers") {
      const markers = args.markers.map((m: any, i: number) => ({ id: `g${i}`, startS: m.atS, endS: m.endS ?? m.atS, name: m.name, comments: "", colour: 0 }));
      listing.markers.push(...markers);
      return { ok: true, created: markers.map((m: any) => m.id), undo: { kind: "markers", sequenceId: "seq-1", markers } };
    }
    if (fn === "gcutToolCutRanges") return cutReply(args);
    if (fn === "gcutToolUndo") return undoReply(args.record);
    if (actReplies[fn]) return actReplies[fn](args);
    throw new Error(`unexpected ${fn}`);
  };
  const turns = createTurns(memoryStore());
  const tools = createTools({ callHost, turns, backend: { transcript: async () => ({ id: "j", status: "running", progress: 0 }), transcriptJob: async () => ({ id: "j", status: "running", progress: 0 }) } });
  const posted: { kind: string; runId?: string; body?: any }[] = [];
  const queue: (AgentStep | ((b: any) => AgentStep) | Error)[] = [];
  const next = (b?: any) => {
    const x = queue.shift();
    if (!x) throw new Error("no scripted step left");
    if (x instanceof Error) throw x;
    return typeof x === "function" ? x(b) : x;
  };
  const api: AgentApi = {
    agentStart: async (body) => { posted.push({ kind: "start", body }); return typeof script.start === "function" ? script.start() : script.start; },
    agentResults: async (runId, results) => { posted.push({ kind: "results", runId, body: results }); return next(results); },
    agentApprove: async (runId) => { posted.push({ kind: "approve", runId }); return next(); },
    agentCancel: async (runId) => { posted.push({ kind: "cancel", runId }); return { ok: true }; },
  };
  let snaps = 0;
  const agent = createAgent({ api, tools, turns, callHost, snapshotTrim: async () => { snaps++; return SNAP; } });
  return { agent, api, host, posted, queue, turns, tools, snaps: () => snaps,
    setListing: (f: (l: any) => any) => { listing = f(listing); }, setCut: (f: (args: any) => any) => { cutReply = f; },
    hostUndo: (f: (record: any) => any) => { undoReply = f; },
    onHost: (fn: string, f: (args: any) => any) => { actReplies[fn] = f; } };
}
const resultsOf = (w: ReturnType<typeof world>, i = 0) => w.posted.filter((p) => p.kind === "results")[i].body;
const hostCalls = (w: ReturnType<typeof world>, fn: string) => w.host.filter(([f]) => f === fn).map(([, a]) => a);

const MARK = { sequenceId: "seq-1", markers: [{ atS: 102, name: "Intro" }] };
const CUT = (clipIds: string[]) => ({ sequenceId: "seq-1", clipIds, ranges: [{ fromS: 102, toS: 103 }] });

describe("send: the plan step", () => {
  it("sends the instruction with the selection taken now; reads run, act calls are answered 'Not approved yet'", async () => {
    const w = world({ start: calls(call("get_sequence", {}), call("add_markers", MARK)) });
    w.queue.push(step("plan", { text: "1. Add a marker Intro at 1:42" }));
    const out = await w.agent.send("add a marker at the intro");
    expect(out).toEqual({ k: "plan", text: "1. Add a marker Intro at 1:42", cost: COST });
    const start = w.posted[0].body;
    expect(start.instruction).toBe("add a marker at the intro");
    expect(start.selection).toMatchObject({ clipIds: [V1, A1], fromS: 100, toS: 110 });
    expect(start.sequence).toMatchObject({ sequenceId: "seq-1", name: "Main", fps: 25 });
    const [read, act] = resultsOf(w);
    expect(read).toMatchObject({ tool_use_id: "tu-get_sequence", is_error: false });
    expect(JSON.parse(read.content).sequenceId).toBe("seq-1");
    expect(act).toEqual({ tool_use_id: "tu-add_markers", content: NOT_APPROVED, is_error: true });
    expect(NOT_APPROVED).toBe("Not approved yet: describe the plan instead");
    expect(hostCalls(w, "gcutToolAddMarkers")).toEqual([]);
    expect(w.agent.isOpen()).toBe(true);
  });

  it("refuses to send with nothing selected, before asking Claude", async () => {
    const w = world({ start: step("plan") });
    w.setListing((l) => ({ ...l, selection: [] }));
    const out = await w.agent.send("add a marker");
    expect(out).toMatchObject({ k: "finished", state: "error", message: "No clip is selected in the timeline. Select the clips to change, then send the instruction." });
    expect(w.posted).toEqual([]);
    expect(w.agent.isOpen()).toBe(false);
  });

  it("never offers undo_last_turn to Claude: an unknown tool is an error result", async () => {
    const w = world({ start: calls(call("undo_last_turn", {})) });
    w.queue.push(step("plan", { text: "1. x" }));
    await w.agent.send("undo");
    expect(resultsOf(w)[0]).toEqual({ tool_use_id: "tu-undo_last_turn", content: "Unknown tool undo_last_turn.", is_error: true });
  });
});

describe("Go: the approved run", () => {
  async function planned(w: ReturnType<typeof world>, plan = "1. Add a marker Intro at 1:42") {
    w.queue.push(step("plan", { text: plan }));
    expect((await w.agent.send("x")).k).toBe("plan");
  }

  it("runs the act calls in one undo group, lists every action, flags the ones not in the plan, then Undo reverses the group", async () => {
    const w = world({ start: calls(call("get_sequence", {})) });
    await planned(w);
    w.queue.push(calls(call("add_markers", MARK), call("cut_ranges", CUT([V1, A1]))), step("done", { text: "Added the marker." }));
    const out = await w.agent.go();
    expect(w.posted.find((p) => p.kind === "approve")).toEqual({ kind: "approve", runId: "r1" });
    expect(out).toMatchObject({ k: "finished", state: "done", text: "Added the marker.", cost: COST, lines: [
      { text: "Added 1 marker: Intro", ok: true, notInPlan: false },
      { text: "Cut 1 range from 1 clip (1 s removed)", ok: true, notInPlan: true }] });
    expect(resultsOf(w, 1).map((r: any) => r.is_error)).toEqual([false, false]);
    const turn = w.turns.latest("seq-1")!;
    expect(turn.actions.map((a) => a.tool)).toEqual(["add_markers", "cut_ranges"]);
    expect(out.k === "finished" && out.undo).toEqual({ sequenceId: "seq-1", turnId: turn.id });
    expect(w.agent.isOpen()).toBe(false);

    const undone = await w.agent.undo((out as any).undo);
    expect(undone).toBe("Undone: Added 1 marker: Intro; Cut 1 range from 1 clip (1 s removed)");
    expect(hostCalls(w, "gcutToolUndo").map((a: any) => [a.record.kind, a.check === true])).toEqual([["cuts", true], ["markers", true], ["cuts", false], ["markers", false]]);
    expect(w.turns.latest("seq-1")).toBeUndefined();
  });

  it("Undo passes on what the group undo says it couldn't take back (a transition stays)", async () => {
    const w = world({ start: calls(call("get_sequence", {})) });
    await planned(w);
    w.queue.push(calls(call("add_markers", MARK)), step("done", { text: "Added the marker." }));
    const out: any = await w.agent.go();
    const note = "The transition stays: Premiere can't remove it from a script. Remove it by hand if needed.";
    w.hostUndo(() => ({ ok: true, skipped: true, message: note })); // as the host answers a transition's record
    expect(await w.agent.undo(out.undo)).toBe(`Undone: Added 1 marker: Intro. ${note}`);
  });

  it("refuses an act call on a clip that wasn't selected, without calling the host", async () => {
    const w = world({ start: calls(call("get_sequence", {})) });
    await planned(w, "1. Cut 1:42-1:43 from V2");
    w.queue.push(calls(call("cut_ranges", CUT([OTHER]))), step("done", { text: "Couldn't." }));
    const out = await w.agent.go();
    const r = resultsOf(w, 1)[0];
    expect(r.is_error).toBe(true);
    expect(r.content).toContain(`${OTHER} isn't one of the selected clips`);
    expect(hostCalls(w, "gcutToolCutRanges")).toEqual([]);
    expect(out).toMatchObject({ lines: [{ ok: false, notInPlan: false }], undo: null });
  });

  it("allows markers inside the selected clips' span only", async () => {
    const w = world({ start: calls(call("get_sequence", {})) });
    await planned(w, "1. Markers");
    w.queue.push(calls(call("add_markers", { sequenceId: "seq-1", markers: [{ atS: 125, name: "Late" }] }, "a"),
      call("add_markers", { sequenceId: "seq-1", markers: [{ atS: 105, endS: 112, name: "Long" }] }, "b"),
      call("add_markers", { sequenceId: "seq-1", markers: [{ atS: 109.5, name: "End" }] }, "c")), step("done"));
    await w.agent.go();
    const [late, long, end] = resultsOf(w, 1);
    expect(late.is_error && late.content).toMatch(/Late.*outside the selected clips \(100–110 s\)/);
    expect(long.is_error && long.content).toMatch(/Long.*outside the selected clips/);
    expect(end.is_error).toBe(false);
  });

  it("swaps the allowed ids through each act result's idMap: pieces of a selected clip are allowed, the replaced id is not", async () => {
    const w = world({ start: calls(call("get_sequence", {})) });
    await planned(w, "1. Cut twice");
    w.setCut((args) => {
      if (args.clipIds[0] === V1) {
        w.setListing((l) => ({ ...l, clips: [clip(P1, "V1", 100, 104), clip(P2, "V1", 104, 109), ...l.clips.slice(1)] }));
        return { ok: true, cutCount: 1, clipCount: 1, removedS: 1, crossfades: 0, idMap: { [V1]: [P1, P2] }, undo: { kind: "cuts", sequenceId: "seq-1" } };
      }
      return { ok: true, cutCount: 1, clipCount: 1, removedS: 1, crossfades: 0, idMap: {}, undo: { kind: "cuts", sequenceId: "seq-1" } };
    });
    // P1 has V1's id by the id scheme (same start, same media); use a moved piece P2 and a stale id.
    const STALE = id("V1", 99, "a");
    w.queue.push(calls(call("cut_ranges", CUT([V1]), "1")), calls(call("cut_ranges", CUT([P2]), "2"), call("cut_ranges", CUT([STALE]), "3")), step("done"));
    await w.agent.go();
    expect(resultsOf(w, 1)[0].is_error).toBe(false);
    const [piece, stale] = resultsOf(w, 2);
    expect(piece.is_error).toBe(false);
    expect(stale.is_error).toBe(true);
    expect(hostCalls(w, "gcutToolCutRanges").map((a: any) => a.clipIds)).toEqual([[V1], [P2]]);
  });

  it("a limit stop part-way keeps what ran as one undoable group, with the backend's message as it is", async () => {
    const w = world({ start: calls(call("get_sequence", {})) });
    await planned(w);
    const LIMIT = "Partial monthly limit reached. You can increase this limit in Settings under the Usage & limit tab.";
    w.queue.push(calls(call("add_markers", MARK)), step("stopped", { reason: "limit", message: LIMIT }));
    const out = await w.agent.go();
    expect(out).toMatchObject({ k: "finished", state: "stopped", message: LIMIT, lines: [{ text: "Added 1 marker: Intro", ok: true }] });
    expect((out as any).undo).toEqual({ sequenceId: "seq-1", turnId: w.turns.latest("seq-1")!.id });
  });

  it("the run and the personal bridge share one undo stack: the bridge's undo_last_turn undoes the run's group", async () => {
    const w = world({ start: calls(call("get_sequence", {})) });
    await planned(w);
    w.queue.push(calls(call("add_markers", MARK), call("cut_ranges", CUT([V1]))), step("done"));
    await w.agent.go();
    expect(await w.tools.undo_last_turn.run({})).toEqual({ ok: true, undone: "Added 1 marker: Intro; Cut 1 range from 1 clip (1 s removed)" });
  });
});

describe("selection rules for the piece-4 tools", () => {
  const ok = (kind: string, idMap: Record<string, string[]> = {}, extra: any = {}) => () => ({ ok: true, idMap, ...extra, undo: { kind, sequenceId: "seq-1" } });
  async function going(w: ReturnType<typeof world>, plan: string, ...c: AgentToolCall[]) {
    w.queue.push(step("plan", { text: plan }));
    await w.agent.send("x");
    w.queue.push(calls(...c), step("done"));
    return w.agent.go();
  }

  it("mute_track is allowed on a track that has a selected clip, refused on any other", async () => {
    const w = world({ start: calls(call("get_sequence", {})) });
    w.onHost("gcutToolMuteTrack", (a) => ({ ok: true, track: `${a.kind === "audio" ? "A" : "V"}${a.track}`, muted: a.muted, changed: true, idMap: {},
      undo: { kind: "mute", sequenceId: "seq-1" } }));
    const out = await going(w, "1. Mute A1 (this mutes all of A1)",
      call("mute_track", { sequenceId: "seq-1", kind: "audio", track: 1, muted: true }, "a1"),
      call("mute_track", { sequenceId: "seq-1", kind: "video", track: 2, muted: true }, "v2"),
      call("mute_track", { sequenceId: "seq-1", kind: "audio", track: 2, muted: true }, "a2"));
    const [a1, v2, a2] = resultsOf(w, 1);
    expect(a1.is_error).toBe(false);
    expect(v2.is_error && v2.content).toMatch(/V2 has none of the selected clips/);
    expect(a2.is_error && a2.content).toMatch(/A2 has none of the selected clips/);
    expect(hostCalls(w, "gcutToolMuteTrack").map((a: any) => [a.kind, a.track])).toEqual([["audio", 1]]);
    expect(out).toMatchObject({ lines: [{ text: "Muted A1", ok: true, notInPlan: false }, { ok: false }, { ok: false }] });
  });

  it("close_gaps and switch_angle take selected clips only, though they reach beyond them", async () => {
    const w = world({ start: calls(call("get_sequence", {})) });
    w.onHost("gcutToolCloseGaps", ok("moves", {}, { gapCount: 1, closedS: 1, movedCount: 1 }));
    w.onHost("gcutToolSwitchAngle", ok("angle", {}, { shown: "V1", hidden: [], splitCount: 0 }));
    await going(w, "1. Close the gap (this also moves everything after 1:50) 2. Switch to camera V1",
      call("close_gaps", { sequenceId: "seq-1", clipIds: [V1, OTHER] }, "g"),
      call("switch_angle", { sequenceId: "seq-1", clipIds: [V1, OTHER], fromS: 101, toS: 102, showTrack: 1 }, "s1"),
      call("switch_angle", { sequenceId: "seq-1", clipIds: [V1], fromS: 101, toS: 102, showTrack: 1 }, "s2"));
    const [g, s1, s2] = resultsOf(w, 1);
    expect(g.is_error && g.content).toContain(`${OTHER} isn't one of the selected clips`);
    expect(s1.is_error).toBe(true);
    expect(s2.is_error).toBe(false);
    expect(hostCalls(w, "gcutToolCloseGaps")).toEqual([]);
  });

  it("an unselected clip that close_gaps moved stays out of the allowed set; a moved selected clip is allowed by its new id", async () => {
    const w = world({ start: calls(call("get_sequence", {})) });
    const V1_MOVED = id("V1", 98, "a"), OTHER_MOVED = id("V2", 118, "z");
    w.onHost("gcutToolCloseGaps", ok("moves", { [V1]: [V1_MOVED], [OTHER]: [OTHER_MOVED] }, { gapCount: 1, closedS: 2, movedCount: 2 }));
    w.onHost("gcutToolSetClipEnabled", ok("enabled", {}, { changed: 1 }));
    w.queue.push(step("plan", { text: "1. Close the gaps, this also moves V2; 2. switch V1 off (disable)" }));
    await w.agent.send("x");
    w.queue.push(calls(call("close_gaps", { sequenceId: "seq-1", clipIds: [V1, A1] })),
      calls(call("set_clip_enabled", { sequenceId: "seq-1", clipIds: [V1_MOVED], enabled: false }, "moved"),
        call("set_clip_enabled", { sequenceId: "seq-1", clipIds: [OTHER_MOVED], enabled: false }, "other"),
        call("set_clip_enabled", { sequenceId: "seq-1", clipIds: [V1], enabled: false }, "old")), step("done"));
    await w.agent.go();
    expect(resultsOf(w, 1)[0].is_error).toBe(false);
    const [moved, other, old] = resultsOf(w, 2);
    expect(moved.is_error).toBe(false);
    expect(other.is_error && other.content).toContain(`${OTHER_MOVED} isn't one of the selected clips`);
    expect(old.is_error).toBe(true);
    expect(hostCalls(w, "gcutToolSetClipEnabled").map((a: any) => a.clipIds)).toEqual([[V1_MOVED]]);
  });

  it("add_transition's single clipId must be selected; split_at's pieces join the allowed set", async () => {
    const w = world({ start: calls(call("get_sequence", {})) });
    const P = id("V1", 104, "a");
    w.onHost("gcutToolSplitAt", ok("split", { [V1]: [V1, P] }, { splitCount: 1 }));
    w.onHost("gcutToolAddTransition", (a) => ({ ok: true, transition: "Cross Dissolve", at: a.at, seconds: a.seconds, idMap: {},
      undo: { kind: "transition", sequenceId: "seq-1" } }));
    w.queue.push(step("plan", { text: "1. Split V1 at 1:44 2. Add a dissolve transition (Undo won't remove it)" }));
    await w.agent.send("x");
    w.queue.push(calls(call("split_at", { sequenceId: "seq-1", clipIds: [V1], atS: 104 })),
      calls(call("add_transition", { sequenceId: "seq-1", clipId: P, at: "start", seconds: 1 }, "p"),
        call("add_transition", { sequenceId: "seq-1", clipId: OTHER, at: "start", seconds: 1 }, "o")), step("done"));
    const out = await w.agent.go();
    const [p, o] = resultsOf(w, 2);
    expect(p.is_error).toBe(false);
    expect(o.is_error && o.content).toContain(`${OTHER} isn't one of the selected clips`);
    expect(out).toMatchObject({ lines: [{ text: "Split 1 clip at 104 s", notInPlan: false },
      { text: "Added a 1 s Cross Dissolve at the start of V1's clip", notInPlan: false }, { ok: false }] });
  });
});

describe("terminal trim handoff", () => {
  it("propose_filler_cuts ends the run: no results posted; the trim gets Claude's instructions and the selection recorded at send", async () => {
    const w = world({ start: calls(call("propose_filler_cuts", { instructions: "remove ums; keep breaths" })) });
    const out = await w.agent.send("trim the ums");
    expect(out).toEqual({ k: "trim", instructions: "remove ums; keep breaths", snapshot: SNAP, snapshotError: null, cost: COST, runId: "r1" });
    expect(w.snaps()).toBe(1);
    expect(w.posted.map((p) => p.kind)).toEqual(["start"]);
    expect(w.agent.isOpen()).toBe(false);
  });
});

describe("cancel and lost runs", () => {
  it("Cancel at the plan discards the run on the backend", async () => {
    const w = world({ start: step("plan", { text: "1. x" }) });
    await w.agent.send("x");
    expect(await w.agent.cancel()).toMatchObject({ k: "finished", state: "cancelled", undo: null });
    expect(w.posted.at(-1)).toEqual({ kind: "cancel", runId: "r1" });
    expect(w.agent.isOpen()).toBe(false);
  });

  it("Cancel during Go stops before the next step and keeps what ran as a group", async () => {
    const w = world({ start: step("plan", { text: "1. Add a marker" }) });
    await w.agent.send("x");
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    w.queue.push(calls(call("add_markers", MARK)));
    const real = w.api.agentResults;
    w.api.agentResults = async (runId, results) => { await gate; return real(runId, results); };
    w.queue.push(calls(call("add_markers", { ...MARK, markers: [{ atS: 103, name: "Second" }] })));
    const going = w.agent.go();
    await new Promise((r) => setTimeout(r, 0));
    expect(await w.agent.cancel()).toBeNull();
    release();
    const out = await going;
    expect(out).toMatchObject({ k: "finished", state: "cancelled", lines: [{ text: "Added 1 marker: Intro" }] });
    expect(hostCalls(w, "gcutToolAddMarkers")).toHaveLength(1);
    expect((out as any).undo).not.toBeNull();
  });

  it("a 404 says the run was lost; what ran stays undoable", async () => {
    const w = world({ start: step("plan", { text: "1. x" }) });
    await w.agent.send("x");
    w.queue.push(calls(call("add_markers", MARK)), new BackendError("This run was lost; send the instruction again.", 404));
    const out = await w.agent.go();
    expect(out).toMatchObject({ k: "finished", state: "lost", message: "This run was lost; send the instruction again." });
    expect((out as any).undo).not.toBeNull();
    expect(w.agent.isOpen()).toBe(false);
  });

  it("any other failure ends the run with its message and discards it on the backend", async () => {
    const w = world({ start: step("plan", { text: "1. x" }) });
    await w.agent.send("x");
    w.queue.push(new BackendError("Anthropic API error 500: overloaded", 502));
    expect(await w.agent.go()).toMatchObject({ k: "finished", state: "error", message: "Anthropic API error 500: overloaded" });
    expect(w.posted.at(-1)).toEqual({ kind: "cancel", runId: "r1" });
  });
});

describe("namedInPlan", () => {
  it("knows each tool by the plain words a plan uses for it", () => {
    expect(namedInPlan("add_markers", "1. Add a marker at 1:42")).toBe(true);
    expect(namedInPlan("cut_ranges", "1. Remove 1:42-1:45 from V1")).toBe(true);
    expect(namedInPlan("cut_ranges", "1. Add a marker")).toBe(false);
    expect(namedInPlan("some_new_tool", "1. some new tool on V1")).toBe(true);
    expect(namedInPlan("set_clip_enabled", "1. Switch off V2 between 1:00 and 1:10")).toBe(true);
    expect(namedInPlan("set_clip_enabled", "1. Turn V2 back on")).toBe(true);
    expect(namedInPlan("close_gaps", "1. Close the gap at 2:10 (this also moves everything after 2:10)")).toBe(true);
    expect(namedInPlan("move_clips", "1. Shift V1 2 s later")).toBe(true);
    expect(namedInPlan("split_at", "1. Split V1 at 1:44")).toBe(true);
    expect(namedInPlan("switch_angle", "1. Show Camera B (V2) from 1:00 to 1:20")).toBe(true);
    expect(namedInPlan("set_volume", "1. Lower A1 by 6 dB")).toBe(true);
    expect(namedInPlan("mute_track", "1. Mute A2 (this mutes all of A2)")).toBe(true);
    expect(namedInPlan("add_transition", "1. Cross dissolve between the two clips")).toBe(true);
    expect(namedInPlan("set_speed", "1. Play V1 at 150%")).toBe(true);
    expect(namedInPlan("delete_clips", "1. Mute A2")).toBe(false);
  });
});

describe("sample data (preview / browser)", () => {
  it("Send hands the instruction to the trim review on the sample clips", async () => {
    const { mockCallHost, mockHost, mockTransport } = await import("../api/mock");
    const { createBackend } = await import("../api/backend");
    const api = createBackend({ transport: mockTransport, token: () => "sample" });
    const turns = createTurns(memoryStore());
    const tools = createTools({ callHost: mockCallHost, backend: api, turns });
    const agent = createAgent({ api, tools, turns, callHost: mockCallHost, snapshotTrim: () => mockHost.snapshotSelection(null) });
    const out = await agent.send("trim the ums");
    expect(out).toMatchObject({ k: "trim", instructions: "trim the ums", snapshot: { found: true, sequenceId: "sample-sequence" } });
    expect((out as any).cost.usd).toBeGreaterThan(0);
  });
});
