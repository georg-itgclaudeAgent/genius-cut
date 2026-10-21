"""The graphics engine: Claude's HTML compositions rendered to transparent MOVs with a pinned HyperFrames CLI.

HTTP routes (all need `Authorization: Bearer <token>`; errors are `{"detail": "..."}`):
- `GET /graphics/status` → `{"ready": bool, "message": str,
    "node": {"ok": bool, "path": str|null, "version": str|null},
    "cli": {"ok": bool, "path": str|null, "version": str|null},
    "chrome": {"ok": bool, "path": str|null},
    "ffmpeg": {"ok": bool, "path": str|null},
    "setup": {"state": "idle"|"running"|"done"|"failed", "message": str}}`
- `POST /graphics/setup` → 202 `{"state": "running", "message": str}`; 409 while one is running; poll
  `GET /graphics/status` (its `setup` block) until done/failed.

Setup (once per machine): Node ≥ 22 must be installed. `npm install --prefix <data dir>/hyperframes
hyperframes@0.8.181` (npm's own npm-cli.js run with that node, so no cmd.exe), then `hyperframes browser ensure`
(HyperFrames keeps its Chrome in its own cache, `~/.cache/hyperframes`) and `browser path`, whose answer is kept
in `<prefix>/browser.json` and passed back as HYPERFRAMES_BROWSER_PATH. GENIUSCUT_HYPERFRAMES_PREFIX overrides the
prefix (tests, dev).

A graphic (`make`): `<folder of the .prproj>/Genius Cut Graphics/<slug>/v<N>/` holds a complete minimal HyperFrames
project: index.html (the root's data-width/height/fps/duration set from the request), hyperframes.json, meta.json,
variables.json, and `assets/` (the brand kit: fonts, GSAP, tokens.css, icons). The composition is always 1920×1080 or 1080×1920; a
3840×2160 / 2160×3840 sequence renders it with `--resolution landscape-4k` / `portrait-4k` (2× DPR). The kit is
copied into every version
(HyperFrames refuses asset paths above the project root, so `../assets` can't be shared); each version renders on
its own, wherever the project moves. Then `check --json` (errors come back as data, the version is removed), `render
--format mov --fps <exact rational>` to `v<N>/<slug>.mov` (ProRes 4444 with alpha), an ffprobe check that the MOV has
no audio stream (a MOV with sound is refused), `preview.png` (ffmpeg, one frame at previewAtS), and
`<slug>/graphic.json` {slug, kind, versions: [{n, created, duration_s, variables, fps, width, height}]}. Versions are
never overwritten. The CLI runs as `node <prefix>/node_modules/hyperframes/bin/hyperframes.mjs` with ffmpeg's folder
first on PATH. One render at a time (the graphics lock); a render is killed after 3 minutes, and a cancel kills it
at once; both kill the whole process tree (taskkill /T on Windows) so Chrome and ffmpeg never linger.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from fractions import Fraction
from pathlib import Path
from typing import Callable

from geniuscut import audio, config, setup

HF_VERSION = "0.8.181"
MIN_NODE = 22
CHECK_TIMEOUT_S = 120
RENDER_TIMEOUT_S = 180
SETUP_TIMEOUT_S = 900
PROBE_TIMEOUT_S = 30
MAX_DURATION_S = 20.0
MIN_DURATION_S = 0.5
MAX_HTML_CHARS = 200_000
# sequence size → (composition size, render --resolution flag). 4K sequences keep the 1080p composition and
# render at 2× device pixel ratio.
SIZES = {(1920, 1080): ((1920, 1080), None), (3840, 2160): ((1920, 1080), "landscape-4k"),
         (1080, 1920): ((1080, 1920), None), (2160, 3840): ((1080, 1920), "portrait-4k")}
KINDS = ("lower-third", "callout", "card", "explainer-scene")
STARTER_PREFIX = "starter-"
FOLDER = "Genius Cut Graphics"
TICKS_PER_SECOND = 254016000000  # Premiere's time base

KIT = Path(__file__).parent / "graphics_kit"

SAVE_FIRST = "Save the project first, so the graphics have a folder."
SIZE_REFUSED = ("Graphics need a 1920×1080, 3840×2160, 1080×1920 or 2160×3840 sequence in this version; this "
                "sequence is {w}×{h}.")
NOT_SET_UP = "Graphics aren't set up on this computer yet: open Settings and click \"Set up graphics\"."
BUSY = "Another graphic is still rendering; try again in a minute."

# Studio-only advice that says nothing about the rendered result.
QUIET_FINDINGS = {"nested_structure_needs_subcomposition", "studio_missing_editable_id",
                  "timed_element_missing_clip_class"}

_SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_ROOT_TAG = re.compile(r"<[a-zA-Z][\w-]*\b[^>]*\bdata-composition-id\s*=\s*(\"[^\"]*\"|'[^']*')[^>]*>")


class GraphicsError(RuntimeError):
    """Something a graphic can't be made from; the message is safe to show (and goes back to Claude)."""


class NotSetUp(GraphicsError):
    pass


class Refused(GraphicsError):
    """The run's project or sequence can't take graphics (unsaved project, other size)."""


class Cancelled(GraphicsError):
    def __init__(self):
        super().__init__("Cancelled.")


class TimedOut(GraphicsError):
    pass


class SetupBusy(RuntimeError):
    pass


@dataclass
class Proc:
    returncode: int
    stdout: str = ""
    stderr: str = ""


# ── processes ──────────────────────────────────────────────────────

def kill_tree(proc) -> None:
    setup._kill_tree(proc)  # taskkill /T /F on Windows: Chrome and ffmpeg die with node


class ProcessRunner:
    """Runs a command to the end, or kills its whole tree on timeout or cancel (checked every poll_s)."""

    def __init__(self, popen: Callable = subprocess.Popen, kill: Callable = kill_tree, poll_s: float = 0.25,
                 clock: Callable = time.monotonic):
        self.popen, self.kill, self.poll_s, self.clock = popen, kill, poll_s, clock

    def __call__(self, cmd: list[str], *, cwd=None, env=None, timeout: float, cancel: threading.Event | None = None
                 ) -> Proc:
        if cancel is not None and cancel.is_set():
            raise Cancelled()
        try:
            proc = self.popen(cmd, cwd=str(cwd) if cwd else None, env=env, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
                              **setup.quiet())
        except OSError as e:
            raise GraphicsError(f"{Path(cmd[0]).name} couldn't start: {e}") from e
        deadline = self.clock() + timeout
        while True:
            try:
                out, err = proc.communicate(timeout=self.poll_s)
                return Proc(proc.returncode, out or "", err or "")
            except subprocess.TimeoutExpired:
                pass
            cancelled = cancel is not None and cancel.is_set()
            if cancelled or self.clock() >= deadline:
                try:
                    self.kill(proc)
                    proc.communicate(timeout=10)
                except Exception:  # noqa: BLE001 — it's gone either way
                    pass
                if cancelled:
                    raise Cancelled()
                raise TimedOut(f"It didn't finish within {round(timeout)} s, so it was stopped.")


def _tail(text: str, lines: int = 25, chars: int = 3000) -> str:
    kept = [ln.rstrip() for ln in (text or "").splitlines() if ln.strip()][-lines:]
    out = "\n".join(kept)
    return out[-chars:]


# ── frame rate, size ───────────────────────────────────────────────

def fps_arg(fps=None, timebase=None) -> str:
    """The exact rate HyperFrames takes: integers as is, NTSC rates as n*1000/1001 (29.97 → 30000/1001), else
    a small fraction. From `fps` (a number or "a/b") or Premiere's `timebase` (ticks per frame)."""
    if timebase not in (None, "", 0):
        rate = Fraction(TICKS_PER_SECOND, int(str(timebase).strip()))
    elif isinstance(fps, str) and "/" in fps:
        num, den = fps.split("/", 1)
        rate = Fraction(int(num), int(den))
    elif fps not in (None, ""):
        rate = Fraction(str(fps))
    else:
        raise Refused("The sequence's frame rate is unknown; send the instruction again from the panel.")
    if rate <= 0 or rate > 240:
        raise Refused(f"The sequence's frame rate ({float(rate):g} fps) can't be rendered.")
    nearest = round(rate)
    if abs(rate - nearest) < Fraction(1, 1000):
        return str(nearest)
    ntsc = round(rate * Fraction(1001, 1000))
    if abs(rate - Fraction(ntsc * 1000, 1001)) < Fraction(1, 500):
        return f"{ntsc * 1000}/1001"
    exact = rate.limit_denominator(1001)
    return f"{exact.numerator}/{exact.denominator}"


def fps_value(arg: str) -> float:
    return float(Fraction(arg))


def check_size(width, height) -> tuple[int, int, str | None]:
    """(composition width, height, --resolution flag or None) for a sequence size; others are refused."""
    try:
        w, h = int(width), int(height)
    except (TypeError, ValueError):
        raise Refused("The sequence's frame size is unknown; send the instruction again from the panel.") from None
    if (w, h) not in SIZES:
        raise Refused(SIZE_REFUSED.format(w=w, h=h))
    (cw, ch), flag = SIZES[(w, h)]
    return cw, ch, flag


def check_slug(slug) -> str:
    if not isinstance(slug, str) or not _SLUG.match(slug) or len(slug) > 40:
        raise GraphicsError("slug must be short lowercase words joined by hyphens (a-z, 0-9), e.g. "
                            "\"mfa-lower-third\".")
    if slug.startswith(STARTER_PREFIX):
        raise GraphicsError(f"Slugs starting with \"{STARTER_PREFIX}\" name the starters; choose another slug.")
    return slug


def graphics_root(project_path) -> Path:
    if not project_path or not str(project_path).strip():
        raise Refused(SAVE_FIRST)
    folder = Path(str(project_path).strip()).parent
    if not folder.is_dir():
        raise Refused(f"The project's folder wasn't found ({folder}). Save the project, then try again.")
    return folder / FOLDER


def set_root_attrs(html: str, attrs: dict[str, str]) -> str:
    """Set data-* attributes on the composition root (the first tag with data-composition-id)."""
    m = _ROOT_TAG.search(html)
    if not m:
        raise GraphicsError("The HTML has no composition root: a <div id=\"root\" data-composition-id=\"main\" …> "
                            "is required.")
    tag = m.group(0)
    for name, value in attrs.items():
        pattern = re.compile(r"\s" + re.escape(name) + r"\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)")
        if pattern.search(tag):
            tag = pattern.sub(f' {name}="{value}"', tag, count=1)
        else:
            end = len(tag) - (2 if tag.endswith("/>") else 1)
            tag = f'{tag[:end]} {name}="{value}"{tag[end:]}'
    return html[:m.start()] + tag + html[m.end():]


def follow_length(html: str, duration: str) -> str:
    """Give the composition the new length: the root's data-duration, and every element that ran the root's
    whole old length (data-duration equal to it, e.g. a starter's one full-length clip) runs the new one."""
    m = _ROOT_TAG.search(html)
    if not m:
        return html
    old = re.search(r"\sdata-duration\s*=\s*[\"']?([\d.]+)", m.group(0))
    if old:
        html = re.sub(r"(\sdata-duration\s*=\s*)([\"'])" + re.escape(old.group(1)) + r"(?=\2)",
                      lambda x: f'{x.group(1)}{x.group(2)}{duration}', html)
    return set_root_attrs(html, {"data-duration": duration})


def preview_time(duration_s: float, fps: float, at=None) -> float:
    """Default just after the entry animation: 40 % of the length, at most 1.5 s in. Kept inside the clip."""
    t = min(0.4 * duration_s, 1.5) if at is None else float(at)
    return max(0.0, min(t, duration_s - 1.0 / fps))


def _iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ── the engine ─────────────────────────────────────────────────────

def default_prefix() -> Path:
    override = os.environ.get("GENIUSCUT_HYPERFRAMES_PREFIX")
    return Path(override) if override else config.data_dir() / "hyperframes"


def node_paths(env=None) -> list[str]:
    env = os.environ if env is None else env
    roots = [env.get("ProgramFiles"), env.get("ProgramFiles(x86)"),
             os.path.join(env.get("LOCALAPPDATA", ""), "Programs") if env.get("LOCALAPPDATA") else None]
    return [os.path.join(r, "nodejs", "node.exe") for r in roots if r]


def find_node(which: Callable = shutil.which, isfile: Callable = os.path.isfile, env=None) -> str | None:
    return which("node") or next((p for p in node_paths(env) if isfile(p)), None)


class Engine:
    def __init__(self, *, runner: Callable | None = None, prefix: Path | None = None,
                 find_node: Callable = find_node, find_tool: Callable = audio.find_tool,
                 render_timeout: float = RENDER_TIMEOUT_S, check_timeout: float = CHECK_TIMEOUT_S,
                 lock: threading.Lock | None = None, poll_s: float = 0.25, kit: Path = KIT):
        self.run = runner or ProcessRunner()
        self.kit = Path(kit)
        self._prefix = Path(prefix) if prefix else None
        self.find_node, self.find_tool = find_node, find_tool
        self.render_timeout, self.check_timeout, self.poll_s = render_timeout, check_timeout, poll_s
        self.lock = lock or threading.Lock()  # one render at a time

    # paths ---------------------------------------------------------
    @property
    def prefix(self) -> Path:
        return self._prefix or default_prefix()

    def cli_path(self) -> Path:
        return self.prefix / "node_modules" / "hyperframes" / "bin" / "hyperframes.mjs"

    def cli_version(self) -> str | None:
        try:
            pkg = json.loads((self.prefix / "node_modules" / "hyperframes" / "package.json").read_text("utf-8"))
        except (OSError, ValueError):
            return None
        return pkg.get("version")

    def browser_path(self) -> str | None:
        try:
            path = json.loads((self.prefix / "browser.json").read_text("utf-8")).get("path")
        except (OSError, ValueError, AttributeError):
            path = None
        return path if path and os.path.isfile(path) else None

    def _ffmpeg(self) -> tuple[str, str]:
        return self.find_tool("ffmpeg"), self.find_tool("ffprobe")

    def env(self, node: str | None = None) -> dict:
        env = dict(os.environ)
        first = []
        try:
            ffmpeg, ffprobe = self._ffmpeg()
            first.append(str(Path(ffmpeg).parent))
            env.update(HYPERFRAMES_FFMPEG_PATH=ffmpeg, HYPERFRAMES_FFPROBE_PATH=ffprobe)
        except audio.FfmpegError:
            pass
        if node:
            first.append(str(Path(node).parent))
        env["PATH"] = os.pathsep.join([*first, env.get("PATH", "")])
        env.update(HYPERFRAMES_NO_TELEMETRY="1", HYPERFRAMES_NO_UPDATE_CHECK="1", HYPERFRAMES_SKIP_SKILLS="1")
        browser = self.browser_path()
        if browser:
            env["HYPERFRAMES_BROWSER_PATH"] = browser
        return env

    # status --------------------------------------------------------
    def node_status(self) -> dict:
        path = self.find_node()
        if not path:
            return {"ok": False, "path": None, "version": None}
        try:
            out = self.run([path, "--version"], env=self.env(), timeout=PROBE_TIMEOUT_S).stdout.strip()
        except GraphicsError:
            return {"ok": False, "path": path, "version": None}
        m = re.match(r"v?(\d+)", out)
        return {"ok": bool(m and int(m.group(1)) >= MIN_NODE), "path": path, "version": out or None}

    def status(self) -> dict:
        node = self.node_status()
        version = self.cli_version()
        cli = {"ok": version == HF_VERSION and self.cli_path().is_file(),
               "path": str(self.cli_path()) if version else None, "version": version}
        browser = self.browser_path()
        chrome = {"ok": bool(browser), "path": browser}
        try:
            ffmpeg = {"ok": True, "path": self._ffmpeg()[0]}
        except audio.FfmpegError:
            ffmpeg = {"ok": False, "path": None}
        if not node["ok"]:
            message = (f"Node.js {MIN_NODE} or newer is needed for graphics"
                       + (f" (found {node['version']})" if node["version"] else "") + ". Install it from nodejs.org.")
        elif not ffmpeg["ok"]:
            message = "FFmpeg is needed for graphics. Install it (winget install Gyan.FFmpeg)."
        elif not (cli["ok"] and chrome["ok"]):
            message = NOT_SET_UP
        else:
            message = f"Graphics are set up (HyperFrames {HF_VERSION})."
        ready = node["ok"] and cli["ok"] and chrome["ok"] and ffmpeg["ok"]
        return {"ready": ready, "message": message, "node": node, "cli": cli, "chrome": chrome, "ffmpeg": ffmpeg}

    def require_ready(self) -> str:
        """The node path, or NotSetUp with the status message."""
        st = self.status()
        if not st["ready"]:
            raise NotSetUp(st["message"])
        return st["node"]["path"]

    # setup ---------------------------------------------------------
    def install(self, progress: Callable[[str], None] = lambda m: None, cancel: threading.Event | None = None) -> str:
        """The one-time install. Returns the finished message; raises GraphicsError."""
        node = self.find_node()
        st = self.node_status()
        if not st["ok"]:
            raise GraphicsError(self.status()["message"])
        try:
            self._ffmpeg()
        except audio.FfmpegError as e:
            raise GraphicsError(str(e)) from e
        self.prefix.mkdir(parents=True, exist_ok=True)
        env = self.env(node)
        npm_cli = Path(node).parent / "node_modules" / "npm" / "bin" / "npm-cli.js"
        npm = [node, str(npm_cli)] if npm_cli.is_file() else [shutil.which("npm.cmd") or "npm.cmd"]
        progress(f"Installing HyperFrames {HF_VERSION}…")
        r = self.run([*npm, "install", "--prefix", str(self.prefix), f"hyperframes@{HF_VERSION}", "--no-audit",
                      "--no-fund", "--loglevel=error"], cwd=self.prefix, env=env, timeout=SETUP_TIMEOUT_S,
                     cancel=cancel)
        if r.returncode != 0 or self.cli_version() != HF_VERSION:
            raise GraphicsError("Installing HyperFrames failed: " + (_tail(r.stderr, 5) or f"exit {r.returncode}"))
        cli = [node, str(self.cli_path())]
        progress("Downloading HyperFrames' Chrome…")
        r = self.run([*cli, "browser", "ensure"], cwd=self.prefix, env=env, timeout=SETUP_TIMEOUT_S, cancel=cancel)
        if r.returncode != 0:
            raise GraphicsError("Getting HyperFrames' Chrome failed: " + (_tail(r.stderr, 5) or f"exit {r.returncode}"))
        r = self.run([*cli, "browser", "path"], cwd=self.prefix, env=env, timeout=PROBE_TIMEOUT_S, cancel=cancel)
        path = (r.stdout or "").strip().splitlines()[-1].strip() if (r.stdout or "").strip() else ""
        if r.returncode != 0 or not path or not os.path.isfile(path):
            raise GraphicsError("HyperFrames' Chrome wasn't found after the download.")
        (self.prefix / "browser.json").write_text(json.dumps({"path": path}), encoding="utf-8")
        return f"Graphics are set up (HyperFrames {HF_VERSION})."

    # graphics ------------------------------------------------------
    def make(self, *, project_path, slug, kind, duration_s, html, width, height, fps=None, timebase=None,
             variables=None, preview_at_s=None, cancel: threading.Event | None = None) -> dict:
        """Write, check and render the next version. Returns {"ok": True, slug, version, path, preview, html,
        duration_s, renderSeconds, warnings} or, for a check or render failure Claude can fix, {"ok": False,
        stage: "check"|"render", errors: [str], warnings: [str]}. Raises Refused / NotSetUp / GraphicsError for
        what Claude can't fix by rewriting, Cancelled when the run was cancelled."""
        root = graphics_root(project_path)
        w, h, resolution = check_size(width, height)
        rate = fps_arg(fps, timebase)
        check_slug(slug)
        if kind not in KINDS:
            raise GraphicsError(f"kind must be one of: {', '.join(KINDS)}.")
        try:
            duration = float(duration_s)
        except (TypeError, ValueError):
            raise GraphicsError("duration_s must be a number of seconds.") from None
        if not MIN_DURATION_S <= duration <= MAX_DURATION_S:
            raise GraphicsError(f"duration_s must be between {MIN_DURATION_S:g} and {MAX_DURATION_S:g} seconds.")
        if not isinstance(html, str) or "data-composition-id" not in html:
            raise GraphicsError("html must be a whole HyperFrames composition (with a data-composition-id root).")
        if len(html) > MAX_HTML_CHARS:
            raise GraphicsError(f"html is too long (over {MAX_HTML_CHARS} characters).")
        if variables is not None and not isinstance(variables, dict):
            raise GraphicsError("variables must be an object of variable values keyed by id.")
        html = follow_length(set_root_attrs(html, {"data-width": str(w), "data-height": str(h), "data-fps": rate}),
                             f"{duration:g}")
        node = self.require_ready()

        folder = root / slug
        folder.mkdir(parents=True, exist_ok=True)
        info = self._info(folder)
        if info.get("kind") and info["kind"] != kind:
            kind = info["kind"]  # a graphic keeps its kind across versions
        n = max([v["n"] for v in info.get("versions", [])] + self._version_dirs(folder) + [0]) + 1
        vdir = folder / f"v{n}"
        vdir.mkdir()
        try:
            self._write_project(vdir, slug, n, html, variables, self.kit)
            env = self.env(node)
            cli = [node, str(self.cli_path())]
            r = self.run([*cli, "check", "--json", "."], cwd=vdir, env=env, timeout=self.check_timeout, cancel=cancel)
            errors, warnings = parse_check(r)
            if errors:
                shutil.rmtree(vdir, ignore_errors=True)
                return {"ok": False, "stage": "check", "errors": errors, "warnings": warnings}
            mov = vdir / f"{slug}.mov"
            started = time.monotonic()
            with self._render_lock(cancel):
                cmd = [*cli, "render", ".", "--format", "mov", "--fps", rate, "--output", str(mov), "--quiet"]
                if resolution:
                    cmd += ["--resolution", resolution]
                if variables:
                    cmd += ["--variables-file", str(vdir / "variables.json")]
                try:
                    r = self.run(cmd, cwd=vdir, env=env, timeout=self.render_timeout, cancel=cancel)
                except TimedOut:
                    shutil.rmtree(vdir, ignore_errors=True)
                    return {"ok": False, "stage": "render", "warnings": warnings, "errors": [
                        f"The render took longer than {round(self.render_timeout / 60)} minutes and was stopped. "
                        "Make the graphic simpler or shorter."]}
            seconds = round(time.monotonic() - started, 1)
            if r.returncode != 0 or not mov.is_file():
                shutil.rmtree(vdir, ignore_errors=True)
                return {"ok": False, "stage": "render", "warnings": warnings,
                        "errors": [_tail(r.stderr or r.stdout) or f"The render failed (exit {r.returncode})."]}
            self._check_streams(mov, env, cancel)
            preview = vdir / "preview.png"
            at = preview_time(duration, fps_value(rate), preview_at_s)
            ffmpeg = self._ffmpeg()[0]
            r = self.run([ffmpeg, "-nostdin", "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{at:.3f}", "-i",
                          str(mov), "-frames:v", "1", str(preview)], env=env, timeout=PROBE_TIMEOUT_S, cancel=cancel)
            if r.returncode != 0 or not preview.is_file():
                raise GraphicsError("The preview frame couldn't be made: " + _tail(r.stderr, 3))
        except BaseException:
            if not (vdir / f"{slug}.mov").is_file() or not (vdir / "preview.png").is_file():
                shutil.rmtree(vdir, ignore_errors=True)
            raise
        info.update(slug=slug, kind=kind)
        info.setdefault("versions", []).append({"n": n, "created": _iso(), "duration_s": duration,
                                                "variables": variables or {}, "fps": rate, "width": int(width),
                                                "height": int(height)})
        (folder / "graphic.json").write_text(json.dumps(info, indent=2), encoding="utf-8")
        return {"ok": True, "slug": slug, "version": n, "path": str(mov), "preview": str(preview),
                "html": str(vdir / "index.html"), "duration_s": duration, "renderSeconds": seconds,
                "warnings": warnings}

    def latest(self, project_path, slug) -> dict | None:
        """{slug, version, preview, path, duration_s} of the newest version, or None."""
        folder = graphics_root(project_path) / slug
        versions = self._info(folder).get("versions") or []
        if not versions:
            return None
        v = versions[-1]
        vdir = folder / f"v{v['n']}"
        return {"slug": slug, "version": v["n"], "preview": str(vdir / "preview.png"),
                "path": str(vdir / f"{slug}.mov"), "duration_s": v["duration_s"]}

    def read(self, project_path, slug) -> dict:
        """The newest version's index.html and its facts; a `starter-<kind>` slug reads that starter."""
        if isinstance(slug, str) and slug.startswith(STARTER_PREFIX):
            kind = slug[len(STARTER_PREFIX):]
            if kind not in KINDS:
                raise GraphicsError(f"No starter {slug!r}; starters: "
                                    + ", ".join(STARTER_PREFIX + k for k in KINDS) + ".")
            return {"slug": slug, "starter": True, "kind": kind,
                    "html": (self.kit / "starters" / f"{kind}.html").read_text("utf-8")}
        check_slug(slug)
        folder = graphics_root(project_path) / slug
        info = self._info(folder)
        versions = info.get("versions") or []
        if not versions:
            raise GraphicsError(f"No graphic {slug!r} in this project's \"{FOLDER}\" folder.")
        v = versions[-1]
        vdir = folder / f"v{v['n']}"
        return {"slug": slug, "kind": info.get("kind"), "version": v["n"], "versions": [x["n"] for x in versions],
                "duration_s": v["duration_s"], "variables": v.get("variables") or {},
                "path": str(vdir / f"{slug}.mov"), "preview": str(vdir / "preview.png"),
                "html": (vdir / "index.html").read_text("utf-8")}

    # internals -----------------------------------------------------
    @staticmethod
    def _info(folder: Path) -> dict:
        try:
            data = json.loads((folder / "graphic.json").read_text("utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    @staticmethod
    def _version_dirs(folder: Path) -> list[int]:
        return [int(p.name[1:]) for p in folder.glob("v*") if p.is_dir() and p.name[1:].isdigit()]

    @staticmethod
    def _write_project(vdir: Path, slug: str, n: int, html: str, variables, kit: Path) -> None:
        (vdir / "index.html").write_text(html, encoding="utf-8")
        (vdir / "hyperframes.json").write_text(json.dumps({
            "$schema": "https://hyperframes.heygen.com/schema/hyperframes.json",
            "paths": {"blocks": "compositions", "components": "compositions/components", "assets": "assets"},
            "media": {"autoProxy": False}}, indent=2), encoding="utf-8")
        (vdir / "meta.json").write_text(json.dumps({"id": f"{slug}-v{n}", "name": slug, "createdAt": _iso()},
                                                   indent=2), encoding="utf-8")
        (vdir / "variables.json").write_text(json.dumps(variables or {}), encoding="utf-8")
        if not kit.is_dir():
            raise GraphicsError(f"The graphics brand kit is missing ({kit}); reinstall Genius Cut.")
        shutil.copytree(kit, vdir / "assets", ignore=shutil.ignore_patterns("starters", "__pycache__"))

    def _render_lock(self, cancel: threading.Event | None):
        engine = self

        class _Held:
            def __enter__(self):
                deadline = time.monotonic() + engine.render_timeout
                while not engine.lock.acquire(timeout=engine.poll_s):
                    if cancel is not None and cancel.is_set():
                        raise Cancelled()
                    if time.monotonic() >= deadline:
                        raise GraphicsError(BUSY)
                return self

            def __exit__(self, *a):
                engine.lock.release()
                return False

        return _Held()

    def _check_streams(self, mov: Path, env: dict, cancel) -> None:
        r = self.run([self._ffmpeg()[1], "-v", "error", "-show_entries", "stream=codec_type,codec_name,pix_fmt",
                      "-of", "json", str(mov)], env=env, timeout=PROBE_TIMEOUT_S, cancel=cancel)
        try:
            streams = json.loads(r.stdout or "{}").get("streams") or []
        except ValueError:
            streams = []
        if r.returncode != 0 or not any(s.get("codec_type") == "video" for s in streams):
            raise GraphicsError("The render has no video stream: " + (_tail(r.stderr, 3) or "ffprobe found none"))
        if any(s.get("codec_type") == "audio" for s in streams):
            raise GraphicsError("The render has an audio stream, which would land on an audio track in Premiere; "
                                "graphics must be silent (no <audio>, no <video> with sound).")


def parse_check(r: Proc) -> tuple[list[str], list[str]]:
    """`check --json` → (errors, warnings) as short lines "code: message (selector)"."""
    try:
        data = json.loads(r.stdout)
    except (TypeError, ValueError):
        return [_tail(r.stderr or r.stdout) or f"hyperframes check failed (exit {r.returncode})."], []
    errors, warnings = [], []
    for section in ("lint", "runtime", "layout", "motion", "contrast"):
        for f in (data.get(section) or {}).get("findings") or []:
            code = f.get("code", section)
            line = f"{section} {code}: {f.get('message', '').strip()}"
            if f.get("selector"):
                line += f" ({f['selector']})"
            if f.get("fixHint"):
                line += f" Fix: {f['fixHint']}"
            if f.get("severity") == "error":
                errors.append(line)
            elif f.get("severity") == "warning" and code not in QUIET_FINDINGS:
                warnings.append(line)
    if not errors and data.get("ok") is False:
        errors.append(f"hyperframes check failed: {_tail(r.stderr, 5) or 'no findings were given'}")
    return errors[:20], warnings[:20]


class Setup:
    """The one-time install as a job, one at a time, watched on a thread (like the gcloud sign-in)."""

    def __init__(self, engine: Engine, thread: Callable = threading.Thread):
        self.engine, self.thread = engine, thread
        self._lock = threading.Lock()
        self._state, self._message = "idle", ""
        self._worker = None

    def status(self) -> dict:
        with self._lock:
            return {"state": self._state, "message": self._message}

    def start(self) -> dict:
        with self._lock:
            if self._state == "running":
                raise SetupBusy("Graphics setup is already running.")
            self._state, self._message = "running", "Starting the graphics setup…"
            self._worker = self.thread(target=self._work, daemon=True)
            self._worker.start()
            return {"state": self._state, "message": self._message}

    def join(self, timeout: float | None = None) -> None:
        if self._worker is not None and hasattr(self._worker, "join"):
            self._worker.join(timeout)

    def _progress(self, message: str) -> None:
        with self._lock:
            self._message = message

    def _work(self) -> None:
        try:
            message = self.engine.install(progress=self._progress)
        except GraphicsError as e:
            self._finish("failed", str(e))
        except Exception as e:  # noqa: BLE001 — report, never leave the job "running"
            self._finish("failed", f"Graphics setup failed: {e}")
        else:
            self._finish("done", message)

    def _finish(self, state: str, message: str) -> None:
        with self._lock:
            self._state, self._message = state, message
