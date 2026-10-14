"""The setup screen's gcloud side: find gcloud, sign in, list projects / secrets / versions.

HTTP routes (all need `Authorization: Bearer <token>`; errors are `{"detail": "..."}`):
- `GET /setup/gcloud` → `{"installed": bool, "path": str|null, "version": str|null, "account": str|null}`
  (account null = nobody signed in).
- `POST /setup/login` → 202 `{"state": "running", "message": str}`; 409 while one is running;
  502 when gcloud isn't installed. Runs `gcloud auth login --quiet` (the browser opens; the editor
  signs in there), no stdin, hidden window, killed after 5 minutes.
- `GET /setup/login` → `{"state": "idle"|"running"|"done"|"failed", "message": str}`; poll it.
- `GET /setup/projects` → `{"projects": [{"id": str, "name": str}]}` sorted by id.
- `GET /setup/secrets?project=` → `{"secrets": [str]}` sorted.
- `GET /setup/versions?project=&secret=` → `{"versions": [{"version": "12", "state": "enabled"|"disabled"|...}]}`
  newest first.
- `GET /usage` → `{"month_usd": float, "limit_usd": float, "limit_tier": 20|100, "resets_on": "YYYY-MM-DD",
  "run_count": int, "runs": [{"at": ISO-8601 UTC, "kind": str, "model": str, "usd": float|null}]}`
  (this month's runs, last 10, newest first; an agent run of many steps is one run).
- `GET /settings` gains `"setup_complete": bool`; only a passing `POST /settings/test-key` sets it
  (and saves that key source); `PUT /settings` keeps it only while the key source is unchanged.
- `/health`'s `ai` block gains `"key_from_cache": bool` (the key in use is the encrypted local copy,
  because gcloud couldn't read Secret Manager: the gcloud login probably expired).
Listing errors: 422 for an invalid project/secret (checked before gcloud runs), 502 for a gcloud
failure (its last error line). Nothing here reads, returns or logs a key.

gcloud is found on PATH or at the standard Windows install paths, so a fresh install works without
restarting Premiere. Every value given to gcloud is validated first (`settings.validate_*`), because
`gcloud.cmd` arguments pass through cmd.exe.
"""

import json
import os
import shutil
import subprocess
import sys
import threading
from typing import Callable

from geniuscut import settings

GCLOUD_TIMEOUT_S = 60
LOGIN_TIMEOUT_S = 300
NOT_INSTALLED = "gcloud is not installed. Install the Google Cloud CLI, then check again."
_CREATE_NO_WINDOW = 0x08000000


class SetupError(RuntimeError):
    """gcloud is missing or failed; the message is safe to show."""


class LoginBusy(RuntimeError):
    pass


def standard_paths(env=None) -> list[str]:
    env = os.environ if env is None else env
    roots = [env.get("LOCALAPPDATA"), env.get("ProgramFiles(x86)"), env.get("ProgramFiles")]
    return [os.path.join(r, "Google", "Cloud SDK", "google-cloud-sdk", "bin", "gcloud.cmd") for r in roots if r]


def find_gcloud(which: Callable = shutil.which, isfile: Callable = os.path.isfile, env=None) -> str | None:
    """gcloud on PATH, else at a standard install path (PATH of a running Premiere is stale)."""
    found = which("gcloud") or which("gcloud.cmd")
    if found:
        return found
    return next((p for p in standard_paths(env) if isfile(p)), None)


def quiet() -> dict:
    """subprocess kwargs: no stdin (gcloud can never wait on a prompt), no console window."""
    kw = {"stdin": subprocess.DEVNULL}
    if sys.platform == "win32":
        kw["creationflags"] = _CREATE_NO_WINDOW
    return kw


def _last_line(text: str | None) -> str:
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    return lines[-1] if lines else ""


def gcloud(args: list[str], *, run: Callable = subprocess.run, path: str | None = None) -> str:
    """Run gcloud, return stdout; SetupError (its last error line) on any failure."""
    path = path or find_gcloud()
    if not path:
        raise SetupError(NOT_INSTALLED)
    try:
        result = run([path, *args], capture_output=True, text=True, timeout=GCLOUD_TIMEOUT_S, **quiet())
    except subprocess.TimeoutExpired as e:
        raise SetupError(f"gcloud didn't answer within {GCLOUD_TIMEOUT_S} s.") from e
    except OSError as e:
        raise SetupError(f"gcloud couldn't start: {e}") from e
    if result.returncode != 0:
        raise SetupError(_last_line(result.stderr) or f"gcloud failed (exit code {result.returncode}).")
    return result.stdout or ""


def status(*, run: Callable = subprocess.run, find: Callable = find_gcloud) -> dict:
    path = find()
    if not path:
        return {"installed": False, "path": None, "version": None, "account": None}
    try:
        first = (gcloud(["--version"], run=run, path=path).splitlines() or [""])[0]
    except SetupError:
        return {"installed": False, "path": path, "version": None, "account": None}
    version = first.replace("Google Cloud SDK", "").strip() or None
    try:
        account = gcloud(["config", "get-value", "account"], run=run, path=path).strip() or None
    except SetupError:
        account = None
    return {"installed": True, "path": path, "version": version, "account": account}


def _json(text: str) -> list:
    try:
        data = json.loads(text or "[]")
    except ValueError as e:
        raise SetupError("gcloud returned something that isn't JSON.") from e
    return data if isinstance(data, list) else []


def list_projects(*, run: Callable = subprocess.run, find: Callable = find_gcloud) -> list[dict]:
    rows = _json(gcloud(["projects", "list", "--format=json"], run=run, path=find()))
    out = [{"id": str(r.get("projectId", "")), "name": str(r.get("name", ""))} for r in rows if isinstance(r, dict)]
    return sorted((p for p in out if p["id"]), key=lambda p: p["id"])


def list_secrets(project: str, *, run: Callable = subprocess.run, find: Callable = find_gcloud) -> list[str]:
    settings.validate_project(project)
    rows = _json(gcloud(["secrets", "list", f"--project={project}", "--format=json"], run=run, path=find()))
    return sorted(str(r.get("name", "")).rsplit("/", 1)[-1] for r in rows if isinstance(r, dict) and r.get("name"))


def list_versions(project: str, secret: str, *, run: Callable = subprocess.run,
                  find: Callable = find_gcloud) -> list[dict]:
    settings.validate_project(project)
    settings.validate_secret(secret)
    rows = _json(gcloud(["secrets", "versions", "list", secret, f"--project={project}", "--format=json"],
                        run=run, path=find()))
    out = [{"version": str(r.get("name", "")).rsplit("/", 1)[-1], "state": str(r.get("state", "")).lower()}
           for r in rows if isinstance(r, dict) and r.get("name")]
    return sorted(out, key=lambda v: int(v["version"]) if v["version"].isdigit() else -1, reverse=True)


def _kill_tree(proc) -> None:
    """gcloud.cmd runs Python under cmd.exe: kill the whole tree, not just cmd.exe."""
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True, **quiet())
    else:
        proc.kill()


class Login:
    """One `gcloud auth login` at a time, watched on a thread, killed after the timeout."""

    def __init__(self, popen: Callable = subprocess.Popen, find: Callable = find_gcloud,
                 kill: Callable = _kill_tree, timeout: float = LOGIN_TIMEOUT_S):
        self.popen, self.find, self.kill, self.timeout = popen, find, kill, timeout
        self._lock = threading.Lock()
        self._state, self._message = "idle", ""
        self._thread: threading.Thread | None = None

    def status(self) -> dict:
        with self._lock:
            return {"state": self._state, "message": self._message}

    def start(self) -> dict:
        with self._lock:
            if self._state == "running":
                raise LoginBusy("A sign-in is already open in the browser.")
            path = self.find()
            if not path:
                raise SetupError(NOT_INSTALLED)
            try:
                proc = self.popen([path, "auth", "login", "--quiet"], stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, **quiet())
            except OSError as e:
                raise SetupError(f"gcloud couldn't start: {e}") from e
            self._state, self._message = "running", "Sign in with Google in the browser window that opened."
            self._thread = threading.Thread(target=self._watch, args=(proc,), daemon=True)
            self._thread.start()
            return {"state": self._state, "message": self._message}

    def join(self, timeout: float | None = None) -> None:
        if self._thread:
            self._thread.join(timeout)

    def _watch(self, proc) -> None:
        try:
            _out, err = proc.communicate(timeout=self.timeout)
        except subprocess.TimeoutExpired:
            try:
                self.kill(proc)
                proc.communicate()
            except Exception:  # noqa: BLE001 — it's gone either way
                pass
            self._finish("failed", f"Sign-in timed out after {round(self.timeout / 60)} minutes. Try again.")
            return
        except Exception as e:  # noqa: BLE001 — report, never leave the job "running"
            self._finish("failed", f"Sign-in failed: {e}")
            return
        if proc.returncode == 0:
            self._finish("done", "Signed in.")
        else:
            self._finish("failed", _last_line(err) or f"Sign-in failed (exit code {proc.returncode}).")

    def _finish(self, state: str, message: str) -> None:
        with self._lock:
            self._state, self._message = state, message
