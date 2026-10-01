export interface BackendPaths { python: string; server: string; cwd: string }
export type BackendLocation = BackendPaths | { needsSetup: true };

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * Where the backend lives relative to the extension folder (use its real path, not a
 * dev symlink): bundled inside it once installed, or next to it in the repo during
 * development. Installed copies have no venv: Python comes from the runtime that
 * Genius Installer Manager installs (`runtimePython`, read from runtime.json; null =
 * no runtime yet → setup needed; undefined = legacy bundled venv).
 */
export function backendPaths(extensionRoot: string, exists: (p: string) => boolean,
                             runtimePython?: string | null): BackendLocation | null {
  const root = norm(extensionRoot);
  const parent = root.slice(0, root.lastIndexOf("/"));
  if (exists(`${root}/backend/server.py`)) {
    const server = `${root}/backend/server.py`, cwd = `${root}/backend`;
    if (runtimePython === undefined) return { python: `${cwd}/.venv/Scripts/python.exe`, server, cwd };
    return runtimePython ? { python: norm(runtimePython), server, cwd } : { needsSetup: true };
  }
  if (exists(`${parent}/backend/server.py`)) {          // dev checkout: repo venv
    return { python: `${parent}/backend/.venv/Scripts/python.exe`, server: `${parent}/backend/server.py`, cwd: `${parent}/backend` };
  }
  return null;
}

/** The `python` path from runtime.json's text, or null if it's missing/malformed. Never throws. */
export function parseRuntimePointer(text: string): string | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v.python === "string" && v.python ? v.python : null;
  } catch {
    return null;
  }
}
