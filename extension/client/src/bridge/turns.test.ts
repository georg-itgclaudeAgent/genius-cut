import { afterEach, describe, it, expect } from "vitest";
import { createRequire } from "module";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTurns, fileTurnStore, MAX_TURNS, type TurnStore } from "./turns";

function memoryStore(text: string | null = null): TurnStore & { text: string | null } {
  const s = { text, read: () => s.text, write: (t: string) => { s.text = t; } };
  return s;
}
const turn = (sequenceId: string, n: number) =>
  ({ sequenceId, tool: "add_markers", args: { n }, summary: `turn ${n}`, undo: { kind: "markers", sequenceId, n } });

describe("the undo stack (one act call = one turn)", () => {
  it("gives the newest turn of a sequence first, then the one before", () => {
    const t = createTurns(memoryStore());
    for (const n of [1, 2, 3]) t.push(turn("seq-1", n));
    expect(t.latest("seq-1")!.summary).toBe("turn 3");
    t.pop("seq-1", t.latest("seq-1")!.id);
    expect(t.latest("seq-1")!.summary).toBe("turn 2");
    t.pop("seq-1", t.latest("seq-1")!.id);
    t.pop("seq-1", t.latest("seq-1")!.id);
    expect(t.latest("seq-1")).toBeUndefined();
  });

  it("records id, time, sequence and summary, with the action (tool, args, summary, undo record) as a group of one", () => {
    const t = createTurns(memoryStore(), () => new Date("2026-10-14T08:00:00Z"));
    t.push(turn("seq-1", 1));
    expect(t.latest("seq-1")).toEqual({ id: expect.any(String), at: "2026-10-14T08:00:00.000Z", sequenceId: "seq-1", summary: "turn 1",
      actions: [{ tool: "add_markers", args: { n: 1 }, summary: "turn 1", undo: { kind: "markers", sequenceId: "seq-1", n: 1 } }] });
  });

  it("keeps a stack per sequence", () => {
    const t = createTurns(memoryStore());
    t.push(turn("seq-1", 1)); t.push(turn("seq-2", 2));
    expect(t.latest("seq-1")!.summary).toBe("turn 1");
    t.pop("seq-2", t.latest("seq-2")!.id);
    expect(t.latest("seq-2")).toBeUndefined();
    expect(t.latest("seq-1")!.summary).toBe("turn 1");
  });

  it("pops only the turn it was asked to (a stale id changes nothing)", () => {
    const t = createTurns(memoryStore());
    t.push(turn("seq-1", 1)); t.push(turn("seq-1", 2));
    t.pop("seq-1", "no-such-turn");
    expect(t.latest("seq-1")!.summary).toBe("turn 2");
  });

  it("persists every change and loads it back (a panel reload keeps Undo)", () => {
    const store = memoryStore();
    const a = createTurns(store);
    a.push(turn("seq-1", 1)); a.push(turn("seq-1", 2)); a.push(turn("seq-2", 3));
    a.pop("seq-1", a.latest("seq-1")!.id);
    const b = createTurns(memoryStore(store.text));
    expect(b.latest("seq-1")).toEqual(a.latest("seq-1"));
    expect(b.latest("seq-2")!.summary).toBe("turn 3");
  });

  it(`keeps the last ${MAX_TURNS} turns per sequence`, () => {
    const store = memoryStore(), t = createTurns(store);
    for (let n = 1; n <= MAX_TURNS + 5; n++) t.push(turn("seq-1", n));
    const back = createTurns(memoryStore(store.text)), seen: string[] = [];
    for (let x = back.latest("seq-1"); x; x = back.latest("seq-1")) { seen.push(x.summary); back.pop("seq-1", x.id); }
    expect(seen).toHaveLength(MAX_TURNS);
    expect(seen[0]).toBe(`turn ${MAX_TURNS + 5}`);
    expect(seen[MAX_TURNS - 1]).toBe("turn 6");
  });

  it("starts empty from a missing or unreadable turns.json", () => {
    expect(createTurns(memoryStore(null)).latest("seq-1")).toBeUndefined();
    expect(createTurns(memoryStore("{not json")).latest("seq-1")).toBeUndefined();
  });
});

describe("grouped turns (one Go = one undo turn)", () => {
  it("between begin and end, every act call joins one turn; its summary lists them", () => {
    const store = memoryStore(), t = createTurns(store);
    t.push(turn("seq-1", 1));
    const g = t.begin();
    t.push(turn("seq-1", 2)); t.push(turn("seq-1", 3));
    expect(t.end()).toMatchObject({ id: g, summary: "turn 2; turn 3" });
    const top = t.latest("seq-1")!;
    expect(top.id).toBe(g);
    expect(top.actions.map((a) => a.summary)).toEqual(["turn 2", "turn 3"]);
    // Saved as it grows: a run that stops part-way keeps what ran.
    expect(JSON.parse(store.text!)["seq-1"]).toHaveLength(2);
    t.pop("seq-1", g);
    expect(t.latest("seq-1")!.summary).toBe("turn 1");
  });

  it("a group that did nothing leaves no turn", () => {
    const t = createTurns(memoryStore());
    t.begin();
    expect(t.end()).toBeUndefined();
    expect(t.latest("seq-1")).toBeUndefined();
  });

  it("after end, an act call is a turn of its own again", () => {
    const t = createTurns(memoryStore());
    t.begin(); t.push(turn("seq-1", 1)); t.end();
    t.push(turn("seq-1", 2));
    expect(t.latest("seq-1")!.actions).toHaveLength(1);
  });

  it("dropping the newest action shrinks the group, and the last one removes it", () => {
    const t = createTurns(memoryStore());
    const g = t.begin(); t.push(turn("seq-1", 1)); t.push(turn("seq-1", 2)); t.end();
    t.dropNewest("seq-1", g);
    expect(t.latest("seq-1")).toMatchObject({ id: g, summary: "turn 1" });
    t.dropNewest("seq-1", g);
    expect(t.latest("seq-1")).toBeUndefined();
  });

  it("loads Phase 1's single-action entries as groups of one", () => {
    const legacy = { "seq-1": [{ id: "t1", at: "2026-10-14T08:00:00.000Z", sequenceId: "seq-1", tool: "add_markers", args: { n: 1 },
      summary: "Added 1 marker: Intro", undo: { kind: "markers", sequenceId: "seq-1" } }] };
    const t = createTurns(memoryStore(JSON.stringify(legacy)));
    expect(t.latest("seq-1")).toEqual({ id: "t1", at: "2026-10-14T08:00:00.000Z", sequenceId: "seq-1", summary: "Added 1 marker: Intro",
      actions: [{ tool: "add_markers", args: { n: 1 }, summary: "Added 1 marker: Intro", undo: { kind: "markers", sequenceId: "seq-1" } }] });
  });
});

describe("fileTurnStore: turns.json on disk", () => {
  const nodeRequire = createRequire(import.meta.url);
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("reads null before the first write, then what was written (creating the folder)", () => {
    dir = mkdtempSync(join(tmpdir(), "gcut-turns-"));
    const file = join(dir, "itGenius", "genius-cut", "turns.json");
    const s = fileTurnStore(nodeRequire("fs"), nodeRequire("path"), file);
    expect(s.read()).toBeNull();
    s.write('{"seq-1":[]}');
    expect(readFileSync(file, "utf8")).toBe('{"seq-1":[]}');
    expect(s.read()).toBe('{"seq-1":[]}');
  });
});
