/** Everything that only exists inside Premiere's CEP runtime. */
import type { Transport } from "./backend";
import { backendPaths, liveRuntimePython } from "../lib/paths";

declare global {
  interface Window {
    cep_node?: { require: (id: string) => any };
    CSInterface?: new () => { evalScript(script: string, cb?: (r: string) => void): void; getSystemPath(t: string): string };
  }
}

export const PORT = 8791;

export function isCEP(): boolean {
  return typeof window !== "undefined" && !!window.cep_node && !!window.CSInterface;
}

function node<T = any>(id: string): T {
  if (!window.cep_node) throw new Error("Node isn't available: this panel must run inside Premiere with --enable-nodejs.");
  return window.cep_node.require(id);
}

function dataDir(): string {
  const path = node("path");
  return path.join(node("process").env.APPDATA, "itGenius", "genius-cut");
}

export function readToken(): string {
  const fs = node("fs"), path = node("path");
  const file = path.join(dataDir(), "token");
  if (!fs.existsSync(file)) throw new Error("The backend hasn't created its token yet. It's probably still starting.");
  return fs.readFileSync(file, "utf8").trim();
}

/** Node http, not fetch: CEP pages run from file://, and Node isn't subject to CORS. */
export const nodeTransport: Transport = (req) =>
  new Promise((resolve, reject) => {
    const http = node("http");
    const r = http.request(
      { host: "127.0.0.1", port: PORT, method: req.method, path: req.path, headers: req.headers },
      (res: any) => {
        const chunks: any[] = [];
        res.on("data", (c: any) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: node("buffer").Buffer.concat(chunks).toString("utf8") }));
      },
    );
    r.on("error", reject);
    if (req.timeoutMs) r.setTimeout(req.timeoutMs, () => r.destroy(new Error("The backend took too long to answer.")));
    if (req.body) r.write(req.body);
    r.end();
  });

export function logPath(): string {
  return node("path").join(dataDir(), "backend.log");
}

const SETUP_MESSAGE = "Genius Cut needs a one-time setup. Open Genius Installer Manager and click Finish setup.";

/** python.exe from the installer's runtime pointer (%LOCALAPPDATA%/itGenius/genius-cut/runtime.json), or null. */
function readRuntimePython(): string | null {
  try {
    const fs = node("fs"), path = node("path");
    const file = path.join(node("process").env.LOCALAPPDATA, "itGenius", "genius-cut", "runtime.json");
    return fs.existsSync(file) ? liveRuntimePython(fs.readFileSync(file, "utf8"), (p: string) => fs.existsSync(p)) : null;
  } catch {
    return null;
  }
}

/** Start the backend detached so it outlives the panel; its output goes to backend.log. */
export function spawnBackend(): void {
  const fs = node("fs");
  const cs = new window.CSInterface!();
  const root = fs.realpathSync(cs.getSystemPath("extension")); // resolve the dev symlink
  const paths = backendPaths(root, (p) => fs.existsSync(p), readRuntimePython());
  if (!paths) throw new Error(`No backend found next to ${root}.`);
  if ("needsSetup" in paths) throw Object.assign(new Error(SETUP_MESSAGE), { needsSetup: true });
  if (!fs.existsSync(paths.python)) throw new Error(`Python not found at ${paths.python}. Set up backend/.venv first.`);
  fs.mkdirSync(dataDir(), { recursive: true });
  const log = fs.openSync(logPath(), "a");
  node("child_process")
    .spawn(paths.python, [paths.server], { cwd: paths.cwd, detached: true, windowsHide: true, stdio: ["ignore", log, log] })
    .unref();
}

/** Stop a process by id: used only for an outdated Genius Cut backend found on our port. */
export function killProcess(pid: number): void {
  node("process").kill(pid);
}

export function evalScript(script: string): Promise<string> {
  return new Promise((resolve) => new window.CSInterface!().evalScript(script, resolve));
}
