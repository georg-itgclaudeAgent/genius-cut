import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { fileUrl, PlanView, RunResult } from "./AgentResult";
import type { Outcome } from "../agent/run";
import type { RunCost } from "../api/types";

const COST: RunCost = { model: "anthropic:claude-opus-5-5", label: "Claude Opus 5.5 (Anthropic)", provider: "anthropic", input_tokens: 12000, output_tokens: 900, usd: 0.07, month_usd: 1.2, limit_usd: 20 };
type Finished = Extract<Outcome, { k: "finished" }>;
const finished = (o: Partial<Finished>): Finished =>
  ({ k: "finished", state: "done", text: "", message: null, lines: [], cost: COST, undo: null, graphics: [], ...o });
const result = (o: Partial<Finished>, extra: { undoing?: boolean; undoMsg?: string | null; undoBad?: boolean } = {}) =>
  renderToStaticMarkup(<RunResult out={finished(o)} undoing={extra.undoing ?? false} undoMsg={extra.undoMsg ?? null}
    undoBad={extra.undoBad ?? false} onUndo={() => {}} onDone={() => {}} />);
const buttons = (html: string) => (html.match(/<button[^>]*>[^<]*<\/button>/g) ?? []).map((b) => b.replace(/<[^>]+>/g, ""));

describe("the plan view", () => {
  it("shows the plan with the model's label, Go and Cancel, and what the run cost so far", () => {
    const html = renderToStaticMarkup(<PlanView text={"1. Add a marker Intro at 1:42\n2. Cut 2:10-2:12"} cost={COST} onGo={() => {}} onCancel={() => {}} />);
    expect(html).toContain("1. Add a marker Intro at 1:42\n2. Cut 2:10-2:12");
    expect(buttons(html)).toEqual(["Go", "Cancel"]);
    expect(html).toContain("This run: $0.07 (Claude Opus 5.5 (Anthropic) · ");
    expect(html).toMatch(/>Plan<.*Claude Opus 5\.5 \(Anthropic\)/);
    expect(html).not.toContain("Claude's plan");
  });
});

describe("the result", () => {
  const LINES = [
    { tool: "add_markers", text: "Added 1 marker: Intro", ok: true, notInPlan: false },
    { tool: "cut_ranges", text: "Cut 1 range from 2 clips (1 s removed)", ok: true, notInPlan: true },
    { tool: "cut_ranges", text: "Failed: V2 is locked.", ok: false, notInPlan: false },
  ];

  it("lists every action, flags the ones not in the plan, offers Undo for the group, and shows the cost", () => {
    const html = result({ text: "Added the marker and cut the pause.", lines: LINES, undo: { sequenceId: "s", turnId: "g" } });
    expect(html).toContain("Done");
    expect(html).toContain("Added the marker and cut the pause.");
    expect(html).toContain("Added 1 marker: Intro");
    expect(html.match(/not in the plan/g)).toHaveLength(1);
    expect(html).toMatch(/Cut 1 range from 2 clips \(1 s removed\).*not in the plan/);
    expect(html).toContain("Failed: V2 is locked.");
    expect(buttons(html)).toEqual(["Undo", "Done"]);
    expect(html).toContain("This run: $0.07");
  });

  it("shows a limit stop's message as the backend gave it, and keeps Undo for what ran", () => {
    const LIMIT = "Your allowed monthly limit has been reached. Please wait until 1 November 2026 to continue, or ask your admin for additional credits.";
    const html = result({ state: "stopped", message: LIMIT, lines: LINES.slice(0, 1), undo: { sequenceId: "s", turnId: "g" } });
    expect(html).toContain(LIMIT);
    expect(buttons(html)).toContain("Undo");
  });

  it("a lost run says to send the instruction again", () => {
    const html = result({ state: "lost", message: "This run was lost; send the instruction again." });
    expect(html).toMatch(/class="note bad"[^>]*>This run was lost; send the instruction again\./);
    expect(buttons(html)).toEqual(["Done"]);
  });

  it("a run that changed nothing has no Undo", () => {
    expect(buttons(result({ state: "cancelled" }))).toEqual(["Done"]);
    expect(result({ state: "cancelled" })).toContain("Cancelled");
  });

  it("after Undo: the reply, and the button waits while it runs", () => {
    expect(result({ lines: LINES, undo: { sequenceId: "s", turnId: "g" } }, { undoing: true })).toMatch(/<button[^>]*disabled[^>]*>Undo<\/button>/);
    const done = result({ lines: LINES }, { undoMsg: "Undone: Added 1 marker: Intro" });
    expect(done).toContain("Undone: Added 1 marker: Intro");
    const refused = result({ lines: LINES, undo: { sequenceId: "s", turnId: "g" } }, { undoMsg: "Nothing was undone: Intro was changed since.", undoBad: true });
    expect(refused).toMatch(/class="note bad"[^>]*>Nothing was undone/);
  });
});

describe("graphic previews", () => {
  const G = { slug: "spf-title", version: 2, preview: "C:\\Users\\Georg M\\Ep #4\\Genius Cut Graphics\\spf-title\\v2\\preview.png",
    path: "C:\\Users\\Georg M\\Ep #4\\Genius Cut Graphics\\spf-title\\v2\\spf-title.mov", duration_s: 5.5 };
  const SRC = "file:///C:/Users/Georg%20M/Ep%20%234/Genius%20Cut%20Graphics/spf-title/v2/preview.png";

  it("a preview's file path becomes a URI-encoded file:/// URL (spaces and # in Windows paths)", () => {
    expect(fileUrl(G.preview)).toBe(SRC);
    expect(fileUrl("/home/g/a b.png")).toBe("file:///home/g/a%20b.png");
  });

  it("the plan shows each graphic's preview on a checkered well, with its slug, version and length", () => {
    const html = renderToStaticMarkup(<PlanView text="1. Lower third spf-title, 5.5 s at 1:12" cost={COST} graphics={[G]} onGo={() => {}} onCancel={() => {}} />);
    expect(html).toContain(`src="${SRC}"`);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('class="gfx-prev"');
    expect(html).toMatch(/spf-title.*v2.*5\.5 s/);
    expect(buttons(html)).toEqual(["Go", "Cancel"]);
  });

  it("no graphics: no preview block in the plan or the result", () => {
    expect(renderToStaticMarkup(<PlanView text="1. x" cost={null} graphics={[]} onGo={() => {}} onCancel={() => {}} />)).not.toContain("gfx");
    expect(result({})).not.toContain("gfx");
  });

  it("the result shows the run's graphics too", () => {
    expect(result({ graphics: [G], lines: [{ tool: "place_graphic", text: "Placed spf-title on V3 at 1:12–1:17", ok: true, notInPlan: false }] }))
      .toContain(`src="${SRC}"`);
  });
});
