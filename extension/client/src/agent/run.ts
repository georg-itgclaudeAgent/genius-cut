/**
 * The panel side of an instruction run (spec "Run rules"): the backend owns Claude, the panel runs
 * the tools. Send → Claude reads and plans (act tools refused until Go) → Go → the act calls run as
 * one undo group → done. One shared tool table and turn stack with the personal bridge (App makes
 * them), so Undo and turns.json have one owner.
 *
 * Selection: the allowed clip ids start as the ones selected when the instruction was sent and are
 * swapped through each act result's idMap {oldId: [newIds]}; markers go inside the span the allowed
 * clips cover now. propose_filler_cuts is terminal: the backend closed the run, and the Cut tab runs
 * today's Analyse on the selection recorded at send, with Claude's instructions.
 */
import type { Backend } from "../api/backend";
import type { AgentStep, AgentToolCall, AgentToolResult, NotFound, RunCost, Snapshot } from "../api/types";
import { undoTurn, type ToolDeps, type ToolTable } from "../bridge/tools";
import type { Turns } from "../bridge/turns";

export type AgentApi = Pick<Backend, "agentStart" | "agentResults" | "agentApprove" | "agentCancel">;

export interface AgentDeps {
  api: AgentApi;
  /** The one tool table (bridge/tools.ts), shared with the personal bridge. */
  tools: ToolTable;
  /** The one undo stack, shared with the personal bridge. */
  turns: Turns;
  callHost: ToolDeps["callHost"];
  /** The Cut tab's selection snapshot, for a trim handoff: taken when the instruction is sent. */
  snapshotTrim: () => Promise<Snapshot | NotFound>;
}

export const NOT_APPROVED = "Not approved yet: describe the plan instead";
export const LOST = "This run was lost; send the instruction again.";
export const NO_SELECTION = "No clip is selected in the timeline. Select the clips to change, then send the instruction.";

export interface ActionLine { tool: string; text: string; ok: boolean; notInPlan: boolean }
export interface UndoTarget { sequenceId: string; turnId: string }

export type Outcome =
  | { k: "plan"; text: string; cost: RunCost | null }
  | { k: "trim"; instructions: string; snapshot: Snapshot | NotFound | null; snapshotError: string | null; cost: RunCost | null }
  | { k: "finished"; state: "done" | "stopped" | "cancelled" | "lost" | "error"; text: string; message: string | null;
      lines: ActionLine[]; cost: RunCost | null; undo: UndoTarget | null };

// The words a plan uses for each tool (spec: calls not named in the plan are flagged, not blocked).
const PLAN_WORDS: Record<string, RegExp> = {
  add_markers: /marker|chapter/i,
  cut_ranges: /\bcut|remov|trim|delet/i,
  delete_clips: /delet|remov/i,
  close_gaps: /gap|close up|ripple/i,
  split_at: /split|razor/i,
  set_clip_label: /label|colou?r/i,
  set_clip_enabled: /enabl|disabl/i,
  move_clips: /\bmov/i,
  switch_angle: /angle|camera|switch/i,
  set_volume: /volume|louder|quieter|\bdb\b|gain/i,
  mute_track: /mute/i,
  add_transition: /transition|dissolve|crossfade|cross fade/i,
  set_speed: /speed|slow|fast/i,
};

export function namedInPlan(tool: string, plan: string): boolean {
  const re = PLAN_WORDS[tool];
  return re ? re.test(plan) : plan.toLowerCase().includes(tool.replace(/_/g, " "));
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const EPS = 0.001;
const TERMINAL = "propose_filler_cuts";

export type Agent = ReturnType<typeof createAgent>;

export function createAgent(deps: AgentDeps) {
  let open = false, approved = false, cancelled = false, driving = false;
  let runId = "", plan = "", cost: RunCost | null = null;
  let allowed = new Set<string>(), lines: ActionLine[] = [];
  let trimSnap: Snapshot | NotFound | null = null, trimError: string | null = null;

  /** Close the run on the panel side: the group ends with whatever ran. */
  function finish(state: Extract<Outcome, { k: "finished" }>["state"], text: string, message: string | null): Outcome {
    open = false; driving = false;
    const g = deps.turns.end();
    return { k: "finished", state, text, message, lines, cost, undo: g ? { sequenceId: g.sequenceId, turnId: g.id } : null };
  }

  /** Why this act call may not run on the selection, or null. */
  async function refusal(name: string, input: any): Promise<string | null> {
    const ids: unknown[] = [...(Array.isArray(input?.clipIds) ? input.clipIds : []), ...(input?.clipId !== undefined ? [input.clipId] : [])];
    const out = ids.map(String).find((x) => !allowed.has(x));
    if (out) return `${out} isn't one of the selected clips (or a piece made from them in this run). Only the selected clips can be changed.`;
    if (name === "add_markers" && Array.isArray(input?.markers)) {
      const listing = await deps.callHost("gcutToolGetSequence", {});
      const mine = (listing.clips as any[]).filter((c) => allowed.has(String(c.id)));
      if (!mine.length) return "None of the selected clips is on the timeline any more, so the markers have nowhere to go.";
      const from = Math.min(...mine.map((c) => c.startS)), to = Math.max(...mine.map((c) => c.endS));
      const r = (x: number) => Math.round(x * 1000) / 1000;
      for (const m of input.markers) {
        const at = Number(m?.atS), end = m?.endS === undefined || m?.endS === null ? at : Number(m.endS);
        if (!(at >= from - EPS && end <= to + EPS)) {
          return `Marker ${JSON.stringify(String(m?.name ?? ""))} is outside the selected clips (${r(from)}–${r(to)} s). Markers go inside the selection.`;
        }
      }
    }
    return null;
  }

  async function runCall(c: AgentToolCall): Promise<AgentToolResult> {
    const fail = (content: string): AgentToolResult => ({ tool_use_id: c.id, content, is_error: true });
    const tool = c.name !== "undo_last_turn" && Object.prototype.hasOwnProperty.call(deps.tools, c.name) ? deps.tools[c.name] : undefined;
    if (!tool) return fail(`Unknown tool ${c.name}.`);
    if (tool.kind === "act") {
      if (!approved) return fail(NOT_APPROVED);
      const why = await refusal(c.name, c.input);
      if (why) {
        lines.push({ tool: c.name, text: `Refused: ${why}`, ok: false, notInPlan: !namedInPlan(c.name, plan) });
        return fail(why);
      }
    }
    try {
      const r: any = await tool.run(c.input ?? {});
      if (tool.kind === "act") {
        for (const [old, made] of Object.entries((r?.idMap ?? {}) as Record<string, string[]>)) {
          allowed.delete(old);
          for (const x of made) allowed.add(String(x));
        }
        const seq = String(c.input?.sequenceId ?? "");
        const text = deps.turns.latest(seq)?.actions.at(-1)?.summary ?? c.name;
        lines.push({ tool: c.name, text, ok: true, notInPlan: !namedInPlan(c.name, plan) });
      }
      return { tool_use_id: c.id, content: JSON.stringify(r ?? null), is_error: false };
    } catch (e) {
      if (tool.kind === "act") lines.push({ tool: c.name, text: `Failed: ${msg(e)}`, ok: false, notInPlan: !namedInPlan(c.name, plan) });
      return fail(msg(e));
    }
  }

  /** Follow the backend's steps until a plan, the end, or a trim handoff. */
  async function drive(first: () => Promise<AgentStep>): Promise<Outcome> {
    driving = true;
    try {
      let reply = await first();
      for (;;) {
        if (cancelled && !runId && reply.run_id) void deps.api.agentCancel(reply.run_id).catch(() => {}); // cancelled before its id came
        runId = reply.run_id || runId;
        if (cancelled) return finish("cancelled", "", null);
        cost = reply.cost ?? cost;
        if (reply.state === "plan") { driving = false; plan = reply.text; return { k: "plan", text: reply.text, cost }; }
        if (reply.state === "done") return finish("done", reply.text, null);
        if (reply.state === "stopped") return finish("stopped", reply.text, reply.message);
        const trim = reply.tool_calls.find((c) => c.name === TERMINAL);
        if (trim) {
          // The backend closed the run; nothing is posted back.
          finish("done", reply.text, null);
          return { k: "trim", instructions: String(trim.input?.instructions ?? ""), snapshot: trimSnap, snapshotError: trimError, cost };
        }
        const results: AgentToolResult[] = [];
        for (const c of reply.tool_calls) {
          if (cancelled) break;
          results.push(await runCall(c));
        }
        if (cancelled) return finish("cancelled", "", null);
        reply = await deps.api.agentResults(runId, results);
      }
    } catch (e) {
      if (cancelled) return finish("cancelled", "", null);
      const status = (e as { status?: number })?.status;
      if (status === 404) return finish("lost", "", msg(e) || LOST);
      if (runId) void deps.api.agentCancel(runId).catch(() => {});
      return finish("error", "", msg(e));
    }
  }

  return {
    isOpen: () => open,

    /** Take the selection now, then ask Claude. */
    async send(instruction: string): Promise<Outcome> {
      open = true; approved = false; cancelled = false; driving = false;
      runId = ""; plan = ""; cost = null; lines = []; trimSnap = null; trimError = null;
      let listing: any;
      try {
        listing = await deps.tools.get_sequence.run({});
        if (!listing.selection?.length) return finish("error", "", NO_SELECTION);
        try { trimSnap = await deps.snapshotTrim(); } catch (e) { trimError = msg(e); }
      } catch (e) {
        return finish("error", "", msg(e));
      }
      const chosen = (listing.clips as any[]).filter((c) => listing.selection.includes(c.id));
      allowed = new Set<string>(listing.selection.map(String));
      const selection = {
        clipIds: [...allowed],
        clips: chosen.map((c) => ({ id: c.id, track: c.track, name: c.name, startS: c.startS, endS: c.endS })),
        fromS: Math.min(...chosen.map((c) => c.startS)),
        toS: Math.max(...chosen.map((c) => c.endS)),
      };
      const sequence = { sequenceId: listing.sequenceId, name: listing.name, fps: listing.fps, durationS: listing.durationS, tracks: listing.tracks };
      return drive(() => deps.api.agentStart({ instruction, selection, sequence }));
    },

    /** Go: Claude does exactly the plan; every act call is one undo group. */
    async go(): Promise<Outcome> {
      if (!open || driving) throw new Error("There is no plan waiting for Go.");
      approved = true;
      deps.turns.begin();
      return drive(() => deps.api.agentApprove(runId));
    },

    /**
     * Cancel: the run is discarded on the backend and never resumed. At a plan: the finished outcome.
     * During a step: null, and the step's own promise resolves as cancelled (what ran stays a group).
     */
    async cancel(): Promise<Outcome | null> {
      if (!open) return null;
      cancelled = true;
      if (runId) void deps.api.agentCancel(runId).catch(() => {});
      return driving ? null : finish("cancelled", "", null);
    },

    /** Undo a run's group (pre-checked; refused unless it is still the newest on its sequence). */
    async undo(target: UndoTarget): Promise<string> {
      const r = await undoTurn(deps, target.sequenceId, target.turnId);
      return r.alreadyUndone ? `Already undone: ${r.undone}` : `Undone: ${r.undone}`;
    },
  };
}
