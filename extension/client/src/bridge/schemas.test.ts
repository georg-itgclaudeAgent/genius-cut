/**
 * The three copies of the tool schemas agree: the backend's (backend/geniuscut/agent.py, what Claude
 * sees in the panel), the panel's tool table (this folder's tools.ts, which runs them) and the personal
 * terminal door's (mcp/premiere-mcp.mjs). Same names, same arguments, same read/act kinds; the backend
 * offers wait_transcript but never undo_last_turn (Undo is a button), and adds the terminal
 * propose_filler_cuts, which the panel's run handles itself.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTools, TOOL_ARGS } from "./tools";
import { createTurns } from "./turns";

const ROOT = resolve(__dirname, "../../../..");
const BACKEND = join(ROOT, "backend");

function python(): string {
  for (const p of [join(BACKEND, ".venv", "Scripts", "python.exe"), join(BACKEND, ".venv", "bin", "python")]) if (existsSync(p)) return p;
  return "python";
}

/** A schema without its descriptions and titles: the shape and the arguments only. */
function shape(x: any): any {
  if (Array.isArray(x)) return x.map(shape);
  if (!x || typeof x !== "object") return x;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x)) {
    if (k === "description" || k === "title") continue;
    out[k] = k === "properties" ? Object.fromEntries(Object.entries(v as object).map(([p, s]) => [p, shape(s)])) : shape(v);
  }
  return out;
}

let backend: { tools: { name: string; input_schema: any }[]; kinds: Record<string, string> };
let mcp: { name: string; inputSchema: any; annotations: { readOnlyHint: boolean } }[];
const panel = createTools({ callHost: async () => ({}), backend: { transcript: async () => ({}) as any, transcriptJob: async () => ({}) as any },
  turns: createTurns({ read: () => null, write: () => {} }) });

beforeAll(() => {
  const dump = "import json; from geniuscut import agent; print(json.dumps({'tools': agent.TOOLS, 'kinds': agent.TOOL_KINDS}))";
  backend = JSON.parse(execFileSync(python(), ["-c", dump], { cwd: BACKEND, encoding: "utf8" }));
  // premiere-mcp as Claude Code runs it, asked for its list (a temp APPDATA: no bridge is read for a list).
  const appData = mkdtempSync(join(tmpdir(), "gcut-schemas-"));
  try {
    const out = execFileSync(process.execPath, [join(ROOT, "mcp", "premiere-mcp.mjs")], {
      input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n", encoding: "utf8", env: { ...process.env, APPDATA: appData } });
    mcp = JSON.parse(out.split("\n")[0]).result.tools;
  } finally {
    rmSync(appData, { recursive: true, force: true });
  }
}, 30000);

describe("the three schema copies", () => {
  it("have the same tool names: the backend has propose_filler_cuts and never undo_last_turn", () => {
    const names = (xs: { name: string }[]) => xs.map((t) => t.name).sort();
    const table = Object.keys(panel).sort();
    expect(names(mcp)).toEqual(table);
    expect(names(backend.tools)).toContain("wait_transcript");
    expect(names(backend.tools)).not.toContain("undo_last_turn");
    expect(names(backend.tools).filter((n) => n !== "propose_filler_cuts")).toEqual(table.filter((n) => n !== "undo_last_turn"));
    expect(backend.kinds.propose_filler_cuts).toBe("terminal");
  });

  it("take the same arguments: the panel table's declared args, the backend's and the MCP's schema properties", () => {
    const mcpBy = Object.fromEntries(mcp.map((t) => [t.name, t]));
    for (const t of backend.tools) {
      if (t.name === "propose_filler_cuts") continue;
      expect([...TOOL_ARGS[t.name]].sort(), t.name).toEqual(Object.keys(t.input_schema.properties).sort());
      expect(shape(mcpBy[t.name].inputSchema), t.name).toEqual(shape(t.input_schema));
    }
    expect(Object.keys(mcpBy.undo_last_turn.inputSchema.properties)).toEqual([...TOOL_ARGS.undo_last_turn]);
  });

  it("agree on which tools act", () => {
    for (const t of mcp) {
      expect(t.annotations.readOnlyHint, t.name).toBe(panel[t.name].kind === "read");
      if (t.name !== "undo_last_turn") expect(backend.kinds[t.name], t.name).toBe(panel[t.name].kind);
    }
  });
});
