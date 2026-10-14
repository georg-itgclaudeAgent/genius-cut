/**
 * The assistant bridge (personal builds only, VITE_GENIUSCUT_CLAUDE=1): an HTTP server on 127.0.0.1
 * inside the panel that premiere-mcp forwards Claude's tool calls to. Node's http via cep_node.
 *
 * Wire protocol (mcp/premiere-mcp.mjs speaks exactly this):
 * - %APPDATA%/itGenius/genius-cut/bridge.json {port, token, pid, panelVersion}: written after listen,
 *   deleted when the panel unloads.
 * - GET /ping → {ok: true, panelVersion} (no token).
 * - POST /tool, Authorization: Bearer <token>, {name, args, client} → {ok: true, result} or
 *   {ok: false, message}; a wrong or missing token → 401 {ok: false, message}.
 * - Every reply carries X-Genius-Cut: gcut-assistant-bridge. The packager refuses any dist containing
 *   that string, so an editor build can never ship the bridge.
 * One tool call runs at a time.
 */
import type { Mode } from "../lib/mode";
import type { ToolTable } from "./tools";

const MARK_HEADER = "X-Genius-Cut";
const MARK = "gcut-assistant-bridge";
const MAX_BODY = 1 << 20;
export const BUSY = "Genius Cut is busy (an instruction run, Analyse, Apply, Restore or Close gap is running in the panel). " +
  "Try again when it has finished.";

export interface Bridge {
  port: number;
  stop(): Promise<void>;
}

export interface BridgeDeps {
  http: any;
  fs: any;
  path: any;
  /** %APPDATA%/itGenius/genius-cut */
  dir: string;
  pid: number;
  panelVersion: string;
  token: string;
  tools: ToolTable;
  /** True while the Cut tab runs Analyse, Apply, Restore or Close gap, or a panel instruction run is open. */
  busy: () => boolean;
}

export function startBridge(d: BridgeDeps): Promise<Bridge> {
  const file = d.path.join(d.dir, "bridge.json");
  let queue: Promise<unknown> = Promise.resolve();

  function reply(res: any, status: number, body: unknown) {
    res.writeHead(status, { "Content-Type": "application/json", [MARK_HEADER]: MARK });
    res.end(JSON.stringify(body));
  }

  async function runTool(name: string, args: unknown) {
    const tool = Object.prototype.hasOwnProperty.call(d.tools, name) ? d.tools[name] : undefined;
    if (!tool) return { ok: false, message: `Unknown tool ${name}.` };
    if (tool.kind === "act" && d.busy()) return { ok: false, message: BUSY };
    try {
      return { ok: true, result: await tool.run(args ?? {}) };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  const server = d.http.createServer((req: any, res: any) => {
    const url = String(req.url || "").split("?")[0];
    if (req.method === "GET" && url === "/ping") return reply(res, 200, { ok: true, panelVersion: d.panelVersion });
    if (req.method !== "POST" || url !== "/tool") return reply(res, 404, { ok: false, message: "Not found." });
    if (req.headers.authorization !== `Bearer ${d.token}`) {
      req.resume();
      return reply(res, 401, { ok: false, message: "Wrong or missing bridge token. Read bridge.json again." });
    }
    const chunks: any[] = [];
    let size = 0;
    req.on("data", (c: any) => {
      size += c.length;
      if (size > MAX_BODY) { reply(res, 413, { ok: false, message: "Request too large." }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (size > MAX_BODY) return;
      let call: any;
      try {
        call = JSON.parse(chunks.map((c) => c.toString("utf8")).join(""));
      } catch {
        return reply(res, 400, { ok: false, message: "The request body isn't JSON." });
      }
      const name = typeof call?.name === "string" ? call.name : "";
      // One call at a time: each waits for the one before it.
      const done = queue.then(() => runTool(name, call?.args));
      queue = done;
      done.then((body) => reply(res, 200, body));
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port as number;
      d.fs.mkdirSync(d.dir, { recursive: true });
      d.fs.writeFileSync(file, JSON.stringify({ port, token: d.token, pid: d.pid, panelVersion: d.panelVersion }));
      resolve({
        port,
        stop: () => new Promise<void>((done) => {
          // Only our own: a panel opened since may have written its bridge there.
          try {
            if (JSON.parse(d.fs.readFileSync(file, "utf8")).token === d.token) d.fs.unlinkSync(file);
          } catch { /* already gone */ }
          server.close(() => done());
          server.closeAllConnections?.();
        }),
      });
    });
  });
}

export interface AssistantDeps {
  /** import.meta.env.VITE_GENIUSCUT_CLAUDE */
  flag: string | undefined;
  mode: Mode;
  evalScript: (s: string) => Promise<string>;
  node: (id: string) => any;
  dataDir: () => string;
  /** The panel's one tool table (and so its one undo stack, turns.json), shared with its instruction runs. */
  tools: ToolTable;
  /** cutTabBusy() || a panel run is open: act calls are refused meanwhile. */
  busy: () => boolean;
  panelVersion: string;
}

/** Only a personal build (VITE_GENIUSCUT_CLAUDE=1) running live in Premiere gets the assistant. */
export function bridgeWanted(flag: string | undefined, mode: Mode): boolean {
  return flag === "1" && mode === "live";
}

/**
 * Check the host has the toolbox (the gcutTool* functions in host/index.jsx, which the manifest loads),
 * then serve the panel's tool table. null when this build or mode doesn't get the assistant.
 */
export async function startAssistant(d: AssistantDeps): Promise<Bridge | null> {
  if (!bridgeWanted(d.flag, d.mode)) return null;
  const out = await d.evalScript(`typeof gcutToolGetSequence === "function" ? "ok" : "Error: gcutToolGetSequence is missing"`);
  if (out !== "ok") {
    throw new Error(`The assistant's Premiere tools aren't loaded (host/index.jsx): ${String(out).replace(/^Error:\s*/, "")}. Restart Premiere.`);
  }
  return startBridge({ http: d.node("http"), fs: d.node("fs"), path: d.node("path"), dir: d.dataDir(), pid: d.node("process").pid,
    panelVersion: d.panelVersion, token: d.node("crypto").randomBytes(32).toString("hex"), tools: d.tools, busy: d.busy });
}
