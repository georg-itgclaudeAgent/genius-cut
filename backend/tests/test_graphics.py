"""The graphics engine (motion graphics plan task 1), with a fake process runner: nothing runs for real."""

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from geniuscut import config, graphics
from geniuscut.graphics import Proc
from server import create_app

NODE = "C:/node/node.exe"

HTML = """<!doctype html>
<html lang="en" data-composition-variables='[{"id":"title","type":"string","label":"Title","default":"Hi"}]'>
<head><meta charset="UTF-8" /><script src="assets/gsap.min.js"></script></head>
<body>
  <div id="root" data-composition-id="main" data-start="0" data-duration="3" data-width="1280" data-height="720">
    <div id="t" class="clip" data-start="0" data-duration="3">Hi</div>
  </div>
  <script>const tl = gsap.timeline({ paused: true }); window.__timelines["main"] = tl;</script>
</body>
</html>"""

CHECK_OK = {"ok": True, "lint": {"ok": True, "findings": [
    {"code": "nested_structure_needs_subcomposition", "severity": "warning", "message": "studio only"},
    {"code": "text_small", "severity": "warning", "message": "Text is small", "selector": "#t"},
    {"code": "container_overflow", "severity": "info", "message": "fyi"}]},
    "runtime": {"ok": True, "findings": []}, "layout": {"ok": True, "findings": []},
    "motion": {"ok": True, "findings": []}, "contrast": {"ok": True, "findings": []}}

CHECK_BAD = {"ok": False, "lint": {"ok": False, "findings": [
    {"code": "gsap_animates_clip_element", "severity": "error", "message": "Don't tween a clip.",
     "selector": "#t", "fixHint": "Animate a child."}]},
    "runtime": {"ok": True, "findings": []}, "layout": {"ok": True, "findings": []},
    "motion": {"ok": True, "findings": []}, "contrast": {"ok": True, "findings": []}}

VIDEO_ONLY = {"streams": [{"codec_type": "video", "codec_name": "prores", "pix_fmt": "yuva444p12le"}]}
WITH_AUDIO = {"streams": [VIDEO_ONLY["streams"][0], {"codec_type": "audio", "codec_name": "aac"}]}


class FakeRunner:
    """Answers each command like the real tools would; renders and previews write their files."""

    def __init__(self, check=CHECK_OK, probe=VIDEO_ONLY, render_rc=0, node="v24.13.1", on_render=None):
        self.calls, self.check, self.probe, self.render_rc, self.node = [], check, probe, render_rc, node
        self.on_render = on_render

    def __call__(self, cmd, *, cwd=None, env=None, timeout, cancel=None):
        self.calls.append({"cmd": list(cmd), "cwd": cwd, "env": env, "timeout": timeout, "cancel": cancel})
        if cmd[-1] == "--version":
            return Proc(0, self.node + "\n")
        if "check" in cmd:
            return Proc(0 if self.check.get("ok") else 1, json.dumps(self.check), "log line\n")
        if "render" in cmd:
            if self.on_render:
                self.on_render(cmd)
            if self.render_rc:
                return Proc(self.render_rc, "", "Error: page crashed\nat frame 12\n")
            Path(cmd[cmd.index("--output") + 1]).write_bytes(b"mov")
            return Proc(0)
        if Path(cmd[0]).name.startswith("ffprobe"):
            return Proc(0, json.dumps(self.probe))
        if Path(cmd[0]).name.startswith("ffmpeg"):
            Path(cmd[-1]).write_bytes(b"png")
            return Proc(0)
        raise AssertionError(f"unexpected command {cmd}")

    def named(self, word):
        return [c for c in self.calls if word in c["cmd"]]


def fake_tool(name):
    return f"C:/ffmpeg/bin/{name}.exe"


@pytest.fixture
def kit(tmp_path):
    k = tmp_path / "kit"
    (k / "fonts").mkdir(parents=True)
    (k / "fonts" / "Outfit-Variable.ttf").write_bytes(b"ttf")
    (k / "icons").mkdir()
    (k / "icons" / "check.svg").write_text("<svg/>")
    (k / "gsap.min.js").write_text("/* gsap */")
    (k / "tokens.css").write_text(":root{}")
    (k / "starters").mkdir()
    (k / "starters" / "lower-third.html").write_text("<starter lower third/>")
    return k


def install_cli(prefix: Path, version=graphics.HF_VERSION, browser=True):
    pkg = prefix / "node_modules" / "hyperframes"
    (pkg / "bin").mkdir(parents=True, exist_ok=True)
    (pkg / "package.json").write_text(json.dumps({"name": "hyperframes", "version": version}))
    (pkg / "bin" / "hyperframes.mjs").write_text("// cli")
    if browser:
        chrome = prefix / "chrome.exe"
        chrome.write_bytes(b"exe")
        (prefix / "browser.json").write_text(json.dumps({"path": str(chrome)}))


@pytest.fixture
def project(tmp_path):
    folder = tmp_path / "My Project"
    folder.mkdir()
    return str(folder / "Edit.prproj")


def engine(tmp_path, kit, runner=None, installed=True, **kw):
    prefix = tmp_path / "hf"
    if installed:
        install_cli(prefix)
    return graphics.Engine(runner=runner or FakeRunner(), prefix=prefix, find_node=lambda: NODE,
                           find_tool=fake_tool, kit=kit, **kw)


def make(e, project, **kw):
    args = dict(project_path=project, slug="mfa-lower-third", kind="lower-third", duration_s=4, html=HTML,
                fps=25, width=1920, height=1080)
    args.update(kw)
    return e.make(**args)


# ── frame rates ────────────────────────────────────────────────────

@pytest.mark.parametrize("fps, want", [(25, "25"), (30.0, "30"), (29.97, "30000/1001"), (23.976, "24000/1001"),
                                       (59.94, "60000/1001"), (24, "24"), ("30000/1001", "30000/1001"),
                                       (50, "50"), (12.5, "25/2")])
def test_fps_is_an_exact_rate_never_a_decimal(fps, want):
    assert graphics.fps_arg(fps) == want


@pytest.mark.parametrize("ticks, want", [("8467200000", "30"), (8475667200, "30000/1001"), ("8475667200", "30000/1001"), ("10160640000", "25"),
                                         ("10594584000", "24000/1001"), ("10584000000", "24"),
                                         ("4237833600", "60000/1001")])
def test_fps_from_premieres_timebase(ticks, want):
    assert graphics.fps_arg(timebase=ticks) == want


def test_an_unknown_frame_rate_is_refused():
    with pytest.raises(graphics.Refused):
        graphics.fps_arg(None)


# ── versions and folders ───────────────────────────────────────────

def test_a_version_is_a_complete_hyperframes_project_next_to_the_prproj(tmp_path, kit, project):
    e = engine(tmp_path, kit)
    out = make(e, project)
    folder = Path(project).parent / "Genius Cut Graphics" / "mfa-lower-third"
    v1 = folder / "v1"
    assert out["ok"] is True and out["version"] == 1 and out["slug"] == "mfa-lower-third"
    assert out["path"] == str(v1 / "mfa-lower-third.mov") and out["preview"] == str(v1 / "preview.png")
    assert out["html"] == str(v1 / "index.html") and out["duration_s"] == 4
    for name in ("index.html", "hyperframes.json", "meta.json", "variables.json", "mfa-lower-third.mov", "preview.png",
                 "assets/fonts/Outfit-Variable.ttf", "assets/gsap.min.js", "assets/tokens.css", "assets/icons/check.svg"):
        assert (v1 / name).is_file(), name
    assert not (v1 / "assets" / "starters").exists()
    info = json.loads((folder / "graphic.json").read_text())
    assert info["slug"] == "mfa-lower-third" and info["kind"] == "lower-third"
    assert [v["n"] for v in info["versions"]] == [1]
    assert info["versions"][0]["fps"] == "25" and info["versions"][0]["duration_s"] == 4


def test_versions_count_up_and_never_overwrite(tmp_path, kit, project):
    e = engine(tmp_path, kit)
    make(e, project)
    folder = Path(project).parent / "Genius Cut Graphics" / "mfa-lower-third"
    first = (folder / "v1" / "index.html").read_text()
    out = make(e, project, html=HTML.replace(">Hi<", ">Bye<"), duration_s=6, variables={"title": "MFA"})
    assert out["version"] == 2 and out["duration_s"] == 6
    assert (folder / "v1" / "index.html").read_text() == first
    assert ">Bye<" in (folder / "v2" / "index.html").read_text()
    assert json.loads((folder / "v2" / "variables.json").read_text()) == {"title": "MFA"}
    info = json.loads((folder / "graphic.json").read_text())
    assert [v["n"] for v in info["versions"]] == [1, 2]
    assert e.latest(project, "mfa-lower-third") == {
        "slug": "mfa-lower-third", "version": 2, "preview": str(folder / "v2" / "preview.png"),
        "path": str(folder / "v2" / "mfa-lower-third.mov"), "duration_s": 6}


def test_the_root_gets_the_sequence_size_rate_and_length(tmp_path, kit, project):
    e = engine(tmp_path, kit)
    make(e, project, fps=29.97, width=1080, height=1920, duration_s=4.5)
    html = (Path(project).parent / "Genius Cut Graphics" / "mfa-lower-third" / "v1" / "index.html").read_text()
    root = next(line for line in html.splitlines() if "data-composition-id" in line)
    for attr in ('data-width="1080"', 'data-height="1920"', 'data-fps="30000/1001"', 'data-duration="4.5"'):
        assert attr in root
    assert "1280" not in root and 'data-duration="3"' not in root
    assert root.count("data-duration") == 1


def test_full_length_clips_follow_the_new_length():
    html = ('<div id="root" data-composition-id="main" data-duration="4"><div class="clip" data-duration="4"></div>'
            "<div class='clip' data-duration='4'></div><div class=\"clip\" data-duration=\"1.5\"></div>"
            '<div data-duration="40"></div></div>')
    out = graphics.follow_length(html, "6.5")
    assert out == ('<div id="root" data-composition-id="main" data-duration="6.5"><div class="clip" '
                   "data-duration=\"6.5\"></div><div class='clip' data-duration='6.5'></div><div class=\"clip\" "
                   'data-duration="1.5"></div><div data-duration="40"></div></div>')
    assert graphics.follow_length('<div data-composition-id="m">x</div>', "3") ==         '<div data-composition-id="m" data-duration="3">x</div>'


def test_the_html_clip_follows_the_requested_length(tmp_path, kit, project):
    make(engine(tmp_path, kit), project, duration_s=7)
    html = (Path(project).parent / "Genius Cut Graphics" / "mfa-lower-third" / "v1" / "index.html").read_text()
    assert html.count('data-duration="7"') == 2 and 'data-duration="3"' not in html


def test_set_root_attrs_adds_missing_ones():
    out = graphics.set_root_attrs('<div id="root" data-composition-id="main">x</div>', {"data-fps": "25"})
    assert out == '<div id="root" data-composition-id="main" data-fps="25">x</div>'
    with pytest.raises(graphics.GraphicsError):
        graphics.set_root_attrs("<div>no root</div>", {"data-fps": "25"})


# ── the commands ───────────────────────────────────────────────────

def test_check_then_render_with_node_directly_and_the_sequence_fps(tmp_path, kit, project):
    runner = FakeRunner()
    e = engine(tmp_path, kit, runner)
    make(e, project, fps=25)
    cli = str(tmp_path / "hf" / "node_modules" / "hyperframes" / "bin" / "hyperframes.mjs")
    v1 = Path(project).parent / "Genius Cut Graphics" / "mfa-lower-third" / "v1"
    check = runner.named("check")[0]
    assert check["cmd"] == [NODE, cli, "check", "--json", "."] and Path(check["cwd"]) == v1
    render = runner.named("render")[0]
    assert render["cmd"][:3] == [NODE, cli, "render"] and Path(render["cwd"]) == v1
    args = render["cmd"]
    assert args[args.index("--format") + 1] == "mov" and args[args.index("--fps") + 1] == "25"
    assert args[args.index("--output") + 1] == str(v1 / "mfa-lower-third.mov")
    assert "--variables-file" not in args
    assert render["timeout"] == graphics.RENDER_TIMEOUT_S
    assert not any("npx" in " ".join(c["cmd"]) for c in runner.calls)


@pytest.mark.parametrize("fps, want", [(29.97, "30000/1001"), (23.976, "24000/1001"), (59.94, "60000/1001")])
def test_ntsc_sequences_render_at_the_exact_rational(tmp_path, kit, project, fps, want):
    runner = FakeRunner()
    make(engine(tmp_path, kit, runner), project, fps=fps)
    args = runner.named("render")[0]["cmd"]
    assert args[args.index("--fps") + 1] == want


def test_variables_go_in_a_file(tmp_path, kit, project):
    runner = FakeRunner()
    make(engine(tmp_path, kit, runner), project, variables={"title": "Turn on \"MFA\""})
    args = runner.named("render")[0]["cmd"]
    path = Path(args[args.index("--variables-file") + 1])
    assert json.loads(path.read_text()) == {"title": "Turn on \"MFA\""}


def test_ffmpegs_folder_is_first_on_the_subprocess_path(tmp_path, kit, project):
    runner = FakeRunner()
    make(engine(tmp_path, kit, runner), project)
    env = runner.named("render")[0]["env"]
    assert env["PATH"].split(os.pathsep)[0] == str(Path("C:/ffmpeg/bin"))
    assert env["HYPERFRAMES_FFMPEG_PATH"] == fake_tool("ffmpeg")
    assert env["HYPERFRAMES_FFPROBE_PATH"] == fake_tool("ffprobe")
    assert env["HYPERFRAMES_BROWSER_PATH"] == str(tmp_path / "hf" / "chrome.exe")
    assert env["HYPERFRAMES_NO_TELEMETRY"] == "1"


def test_the_preview_is_one_frame_at_40_percent_capped_at_1_5_s(tmp_path, kit, project):
    runner = FakeRunner()
    e = engine(tmp_path, kit, runner)
    make(e, project, duration_s=2)
    make(e, project, duration_s=10)
    make(e, project, duration_s=10, preview_at_s=3)
    make(e, project, duration_s=2, preview_at_s=9)
    ffmpeg = [c["cmd"] for c in runner.calls if Path(c["cmd"][0]).name == "ffmpeg.exe"]
    assert [c[c.index("-ss") + 1] for c in ffmpeg] == ["0.800", "1.500", "3.000", "1.960"]
    assert all(c[c.index("-frames:v") + 1] == "1" and c[-1].endswith("preview.png") for c in ffmpeg)


# ── errors as data, refusals ───────────────────────────────────────

def test_check_errors_come_back_as_data_and_nothing_renders(tmp_path, kit, project):
    runner = FakeRunner(check=CHECK_BAD)
    e = engine(tmp_path, kit, runner)
    out = make(e, project)
    assert out["ok"] is False and out["stage"] == "check"
    assert out["errors"] == ["lint gsap_animates_clip_element: Don't tween a clip. (#t) Fix: Animate a child."]
    assert runner.named("render") == []
    folder = Path(project).parent / "Genius Cut Graphics" / "mfa-lower-third"
    assert not (folder / "v1").exists()  # a failed version is removed; the next try is v1 again
    runner.check = CHECK_OK
    assert make(e, project)["version"] == 1


def test_check_warnings_pass_through_without_studio_only_advice(tmp_path, kit, project):
    out = make(engine(tmp_path, kit), project)
    assert out["warnings"] == ["lint text_small: Text is small (#t)"]


def test_unreadable_check_output_is_an_error_with_its_stderr():
    errors, warnings = graphics.parse_check(Proc(1, "not json", "Error: Chrome failed to launch"))
    assert errors == ["Error: Chrome failed to launch"] and warnings == []


def test_a_render_failure_comes_back_as_data(tmp_path, kit, project):
    out = make(engine(tmp_path, kit, FakeRunner(render_rc=1)), project)
    assert out["ok"] is False and out["stage"] == "render"
    assert "page crashed" in out["errors"][0] and "frame 12" in out["errors"][0]
    assert not (Path(project).parent / "Genius Cut Graphics" / "mfa-lower-third" / "v1").exists()


def test_a_mov_with_an_audio_stream_is_refused(tmp_path, kit, project):
    with pytest.raises(graphics.GraphicsError, match="audio stream"):
        make(engine(tmp_path, kit, FakeRunner(probe=WITH_AUDIO)), project)
    assert not (Path(project).parent / "Genius Cut Graphics" / "mfa-lower-third" / "v1").exists()


@pytest.mark.parametrize("w, h", [(1280, 720), (4096, 2160), (1080, 1080), (2560, 1440)])
def test_other_sequence_sizes_are_refused(tmp_path, kit, project, w, h):
    runner = FakeRunner()
    with pytest.raises(graphics.Refused, match=f"{w}×{h}"):
        make(engine(tmp_path, kit, runner), project, width=w, height=h)
    assert runner.calls == []


@pytest.mark.parametrize("w, h, comp, flag", [(1920, 1080, (1920, 1080), None),
                                              (3840, 2160, (1920, 1080), "landscape-4k"),
                                              (1080, 1920, (1080, 1920), None),
                                              (2160, 3840, (1080, 1920), "portrait-4k")])
def test_4k_sequences_render_the_1080p_composition_at_2x(tmp_path, kit, project, w, h, comp, flag):
    runner = FakeRunner()
    out = make(engine(tmp_path, kit, runner), project, width=w, height=h)
    assert out["ok"] is True
    args = runner.named("render")[0]["cmd"]
    if flag:
        assert args[args.index("--resolution") + 1] == flag
    else:
        assert "--resolution" not in args
    folder = Path(project).parent / "Genius Cut Graphics" / "mfa-lower-third"
    html = (folder / "v1" / "index.html").read_text()
    root = next(line for line in html.splitlines() if "data-composition-id" in line)
    assert f'data-width="{comp[0]}"' in root and f'data-height="{comp[1]}"' in root
    v = json.loads((folder / "graphic.json").read_text())["versions"][0]
    assert (v["width"], v["height"]) == (w, h)  # the sequence size the render is for


def test_the_rate_can_come_from_the_timebase(tmp_path, kit, project):
    runner = FakeRunner()
    make(engine(tmp_path, kit, runner), project, fps=None, timebase="8467200000")
    args = runner.named("render")[0]["cmd"]
    assert args[args.index("--fps") + 1] == "30"


@pytest.mark.parametrize("path", ["", "  ", None])
def test_an_unsaved_project_is_refused(tmp_path, kit, path):
    with pytest.raises(graphics.Refused, match="Save the project first"):
        make(engine(tmp_path, kit), path)


@pytest.mark.parametrize("bad", [dict(slug="Bad Slug"), dict(slug="starter-lower-third"), dict(kind="poster"),
                                 dict(duration_s=0.1), dict(duration_s=25), dict(html="<p>no root</p>"),
                                 dict(variables=["x"])])
def test_bad_requests_are_refused_before_anything_runs(tmp_path, kit, project, bad):
    runner = FakeRunner()
    with pytest.raises(graphics.GraphicsError):
        make(engine(tmp_path, kit, runner), project, **bad)
    assert runner.named("check") == []


def test_not_set_up_says_how(tmp_path, kit, project):
    with pytest.raises(graphics.NotSetUp, match="Set up graphics"):
        make(engine(tmp_path, kit, installed=False), project)


def test_status_reports_each_part(tmp_path, kit):
    st = engine(tmp_path, kit).status()
    assert st["ready"] is True and "0.8.181" in st["message"]
    assert st["node"] == {"ok": True, "path": NODE, "version": "v24.13.1"}
    assert st["cli"]["ok"] and st["cli"]["version"] == "0.8.181"
    assert st["chrome"] == {"ok": True, "path": str(tmp_path / "hf" / "chrome.exe")}
    assert st["ffmpeg"] == {"ok": True, "path": fake_tool("ffmpeg")}


def test_status_old_node_and_wrong_cli(tmp_path, kit):
    st = engine(tmp_path, kit, FakeRunner(node="v20.11.0")).status()
    assert st["ready"] is False and "Node.js 22" in st["message"] and "v20.11.0" in st["message"]
    prefix = tmp_path / "other"
    install_cli(prefix, version="0.9.0")
    e = graphics.Engine(runner=FakeRunner(), prefix=prefix, find_node=lambda: NODE, find_tool=fake_tool, kit=kit)
    assert e.status()["ready"] is False and e.status()["message"] == graphics.NOT_SET_UP


def test_no_node_at_all(tmp_path, kit):
    e = graphics.Engine(runner=FakeRunner(), prefix=tmp_path / "hf", find_node=lambda: None, find_tool=fake_tool,
                        kit=kit)
    st = e.status()
    assert st["ready"] is False and st["node"]["ok"] is False and "Install it from nodejs.org" in st["message"]


def test_find_node_on_path_else_program_files(tmp_path):
    assert graphics.find_node(which=lambda n: "C:/x/node.exe") == "C:/x/node.exe"
    env = {"ProgramFiles": str(tmp_path)}
    (tmp_path / "nodejs").mkdir()
    (tmp_path / "nodejs" / "node.exe").write_bytes(b"")
    assert graphics.find_node(which=lambda n: None, env=env) == str(tmp_path / "nodejs" / "node.exe")


# ── reading back ───────────────────────────────────────────────────

def test_read_returns_the_newest_html_and_starters(tmp_path, kit, project):
    e = engine(tmp_path, kit)
    make(e, project)
    make(e, project, html=HTML.replace(">Hi<", ">Two<"), variables={"title": "x"})
    got = e.read(project, "mfa-lower-third")
    assert got["version"] == 2 and got["versions"] == [1, 2] and ">Two<" in got["html"]
    assert got["kind"] == "lower-third" and got["variables"] == {"title": "x"}
    assert e.read(project, "starter-lower-third") == {"slug": "starter-lower-third", "starter": True,
                                                      "kind": "lower-third", "html": "<starter lower third/>"}
    with pytest.raises(graphics.GraphicsError, match="No graphic"):
        e.read(project, "nothing-here")
    with pytest.raises(graphics.GraphicsError, match="No starter"):
        e.read(project, "starter-poster")
    assert e.latest(project, "nothing-here") is None


# ── one render at a time, timeout, cancel ──────────────────────────

def test_a_second_render_waits_for_the_lock(tmp_path, kit, project):
    lock = threading.Lock()
    lock.acquire()
    e = engine(tmp_path, kit, lock=lock, poll_s=0.02)
    threading.Timer(0.2, lock.release).start()
    started = time.monotonic()
    assert make(e, project)["ok"] is True
    assert time.monotonic() - started >= 0.15
    assert not lock.locked()


def test_the_lock_wait_ends_with_busy_after_the_render_timeout(tmp_path, kit, project):
    lock = threading.Lock()
    lock.acquire()
    runner = FakeRunner()
    e = engine(tmp_path, kit, runner, lock=lock, poll_s=0.02, render_timeout=0.1)
    with pytest.raises(graphics.GraphicsError, match="still rendering"):
        make(e, project)
    assert runner.named("render") == []


def test_cancel_while_waiting_for_the_lock(tmp_path, kit, project):
    lock = threading.Lock()
    lock.acquire()
    cancel = threading.Event()
    e = engine(tmp_path, kit, lock=lock, poll_s=0.02)
    threading.Timer(0.1, cancel.set).start()
    with pytest.raises(graphics.Cancelled):
        make(e, project, cancel=cancel)
    assert not (Path(project).parent / "Genius Cut Graphics" / "mfa-lower-third" / "v1").exists()


def test_the_cancel_event_reaches_every_command(tmp_path, kit, project):
    runner = FakeRunner()
    cancel = threading.Event()
    make(engine(tmp_path, kit, runner), project, cancel=cancel)
    assert all(c["cancel"] is cancel for c in runner.calls if c["cmd"][-1] != "--version")


def test_a_render_timeout_comes_back_as_data(tmp_path, kit, project):
    def slow(cmd):
        raise graphics.TimedOut("It didn't finish within 180 s, so it was stopped.")

    out = make(engine(tmp_path, kit, FakeRunner(on_render=slow)), project)
    assert out["ok"] is False and out["stage"] == "render" and "longer than 3 minutes" in out["errors"][0]


class FakeProc:
    def __init__(self, finishes_after=None, pid=4242):
        self.pid, self.returncode, self.waits, self.finishes_after = pid, None, 0, finishes_after
        self.killed = False

    def communicate(self, timeout=None):
        self.waits += 1
        if self.killed or (self.finishes_after is not None and self.waits >= self.finishes_after):
            self.returncode = -9 if self.killed else 0
            return "out", "err"
        raise subprocess.TimeoutExpired("node", timeout)


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        self.t += 1.0
        return self.t


def runner_with(proc, popened, killed, **kw):
    def popen(cmd, **k):
        popened.append((cmd, k))
        return proc

    def kill(p):
        killed.append(p)
        p.killed = True

    return graphics.ProcessRunner(popen=popen, kill=kill, poll_s=0.01, **kw)


def test_the_runner_returns_output_and_starts_quietly():
    proc, popened, killed = FakeProc(finishes_after=3), [], []
    r = runner_with(proc, popened, killed)([NODE, "x.mjs", "render"], cwd="C:/p", env={"A": "1"}, timeout=60)
    assert (r.returncode, r.stdout, r.stderr) == (0, "out", "err")
    cmd, kw = popened[0]
    assert cmd == [NODE, "x.mjs", "render"] and kw["cwd"] == "C:/p" and kw["env"] == {"A": "1"}
    assert kw["stdin"] == subprocess.DEVNULL and killed == []
    if sys.platform == "win32":
        assert kw["creationflags"] == 0x08000000


def test_the_runner_kills_the_tree_on_timeout():
    proc, popened, killed = FakeProc(), [], []
    with pytest.raises(graphics.TimedOut):
        runner_with(proc, popened, killed, clock=Clock())([NODE, "x"], timeout=5)
    assert killed == [proc]


def test_the_runner_kills_the_tree_on_cancel():
    proc, popened, killed = FakeProc(), [], []
    cancel = threading.Event()
    threading.Timer(0.05, cancel.set).start()
    with pytest.raises(graphics.Cancelled):
        runner_with(proc, popened, killed)([NODE, "x"], timeout=60, cancel=cancel)
    assert killed == [proc]


def test_an_already_cancelled_run_starts_nothing():
    popened = []
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(graphics.Cancelled):
        runner_with(FakeProc(), popened, [])([NODE, "x"], timeout=60, cancel=cancel)
    assert popened == []


def test_the_default_kill_is_a_taskkill_of_the_whole_tree(monkeypatch):
    ran = []
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(subprocess, "run", lambda cmd, **kw: ran.append(cmd))
    graphics.kill_tree(FakeProc(pid=777))
    assert ran == [["taskkill", "/T", "/F", "/PID", "777"]]


# ── setup ──────────────────────────────────────────────────────────

class SetupRunner(FakeRunner):
    def __init__(self, prefix, npm_rc=0, chrome=None):
        super().__init__()
        self.prefix, self.npm_rc, self.chrome = prefix, npm_rc, chrome

    def __call__(self, cmd, *, cwd=None, env=None, timeout, cancel=None):
        if "install" in cmd:
            self.calls.append({"cmd": list(cmd), "cwd": cwd, "env": env, "timeout": timeout})
            if self.npm_rc:
                return Proc(self.npm_rc, "", "npm ERR! network\n")
            install_cli(self.prefix, browser=False)
            return Proc(0)
        if "browser" in cmd:
            self.calls.append({"cmd": list(cmd), "cwd": cwd, "env": env, "timeout": timeout})
            return Proc(0, (self.chrome + "\n") if cmd[-1] == "path" else "ok")
        return super().__call__(cmd, cwd=cwd, env=env, timeout=timeout, cancel=cancel)


def test_setup_installs_the_pinned_cli_into_the_data_dir_and_records_chrome(tmp_path, kit, monkeypatch):
    monkeypatch.delenv("GENIUSCUT_HYPERFRAMES_PREFIX", raising=False)
    prefix = config.data_dir() / "hyperframes"
    chrome = tmp_path / "cache" / "chrome-headless-shell.exe"
    chrome.parent.mkdir()
    chrome.write_bytes(b"exe")
    runner = SetupRunner(prefix, chrome=str(chrome))
    e = graphics.Engine(runner=runner, find_node=lambda: NODE, find_tool=fake_tool, kit=kit)
    assert e.prefix == prefix and e.status()["ready"] is False
    job = graphics.Setup(e)
    assert job.start()["state"] == "running"
    job.join(5)
    assert job.status() == {"state": "done", "message": "Graphics are set up (HyperFrames 0.8.181)."}
    npm = runner.named("install")[0]["cmd"]
    assert npm[0] == NODE or npm[0].endswith("npm.cmd")
    assert npm[npm.index("--prefix") + 1] == str(prefix) and "hyperframes@0.8.181" in npm
    ensure = runner.named("ensure")[0]["cmd"]
    assert ensure[:2] == [NODE, str(prefix / "node_modules" / "hyperframes" / "bin" / "hyperframes.mjs")]
    assert json.loads((prefix / "browser.json").read_text()) == {"path": str(chrome)}
    assert e.status()["ready"] is True


def test_a_failed_setup_says_why(tmp_path, kit):
    runner = SetupRunner(tmp_path / "hf", npm_rc=1)
    job = graphics.Setup(graphics.Engine(runner=runner, prefix=tmp_path / "hf", find_node=lambda: NODE,
                                         find_tool=fake_tool, kit=kit))
    job.start()
    job.join(5)
    st = job.status()
    assert st["state"] == "failed" and "npm ERR! network" in st["message"]


def test_setup_needs_node_22(tmp_path, kit):
    runner = SetupRunner(tmp_path / "hf")
    runner.node = "v18.0.0"
    job = graphics.Setup(graphics.Engine(runner=runner, prefix=tmp_path / "hf", find_node=lambda: NODE,
                                         find_tool=fake_tool, kit=kit))
    job.start()
    job.join(5)
    assert job.status()["state"] == "failed" and "Node.js 22" in job.status()["message"]
    assert runner.named("install") == []


def test_only_one_setup_at_a_time(tmp_path, kit):
    class Held:
        def __init__(self, target, daemon):
            pass

        def start(self):
            pass

    job = graphics.Setup(engine(tmp_path, kit), thread=Held)
    job.start()
    with pytest.raises(graphics.SetupBusy):
        job.start()


# ── routes ─────────────────────────────────────────────────────────

def client(tmp_path, e, job=None):
    token = config.get_or_create_token(tmp_path)
    a = create_app(token=token, stt_device=lambda: "cuda", library_dir=tmp_path / "library", graphics_engine=e,
                   graphics_setup=job)
    return TestClient(a, base_url="http://127.0.0.1:8791"), {"Authorization": f"Bearer {token}"}


def test_graphics_status_route(tmp_path, kit):
    c, auth = client(tmp_path, engine(tmp_path, kit))
    body = c.get("/graphics/status", headers=auth).json()
    assert body["ready"] is True and body["setup"] == {"state": "idle", "message": ""}
    assert set(body) == {"ready", "message", "node", "cli", "chrome", "ffmpeg", "setup"}


def test_graphics_setup_route_starts_once(tmp_path, kit):
    class Held:
        def __init__(self, target, daemon):
            pass

        def start(self):
            pass

    e = engine(tmp_path, kit)
    c, auth = client(tmp_path, e, graphics.Setup(e, thread=Held))
    r = c.post("/graphics/setup", headers=auth)
    assert r.status_code == 202 and r.json()["state"] == "running"
    assert c.post("/graphics/setup", headers=auth).status_code == 409
    assert c.get("/graphics/status", headers=auth).json()["setup"]["state"] == "running"


@pytest.mark.parametrize("method, path", [("get", "/graphics/status"), ("post", "/graphics/setup")])
def test_graphics_routes_need_the_token(tmp_path, kit, method, path):
    c, _ = client(tmp_path, engine(tmp_path, kit))
    assert getattr(c, method)(path).status_code == 401
