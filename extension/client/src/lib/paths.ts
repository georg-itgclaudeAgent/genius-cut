export interface BackendPaths { python: string; server: string; cwd: string }

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * Where the backend lives relative to the extension folder (use its real path, not a
 * dev symlink): bundled inside it once installed (Task 17), or next to it in the repo
 * during development.
 */
export function backendPaths(extensionRoot: string, exists: (p: string) => boolean): BackendPaths | null {
  const root = norm(extensionRoot);
  const parent = root.slice(0, root.lastIndexOf("/"));
  for (const dir of [`${root}/backend`, `${parent}/backend`]) {
    if (exists(`${dir}/server.py`)) {
      return { python: `${dir}/.venv/Scripts/python.exe`, server: `${dir}/server.py`, cwd: dir };
    }
  }
  return null;
}
