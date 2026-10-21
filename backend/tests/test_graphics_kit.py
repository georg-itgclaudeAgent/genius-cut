"""The itGenius brand kit and the four starters (motion graphics plan task 2).

The fast tests read the files. The slow ones check and render every starter with the real HyperFrames CLI; they
run only where it is installed (GENIUSCUT_HYPERFRAMES_PREFIX, or the "Set up graphics" folder in %APPDATA%).
"""

import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

import pytest

from geniuscut import audio, graphics

KIT = graphics.KIT
STARTERS = {k: (KIT / "starters" / f"{k}.html").read_text("utf-8") for k in graphics.KINDS}
DEFAULT_DURATION = {"lower-third": 4, "callout": 3, "card": 6, "explainer-scene": 8}


def _real_prefix() -> Path | None:
    candidates = [os.environ.get("GENIUSCUT_HYPERFRAMES_PREFIX")]
    if os.environ.get("APPDATA"):
        candidates.append(str(Path(os.environ["APPDATA"]) / "itGenius" / "genius-cut" / "hyperframes"))
    for c in filter(None, candidates):
        if (Path(c) / "node_modules" / "hyperframes" / "bin" / "hyperframes.mjs").is_file():
            return Path(c)
    return None


REAL = _real_prefix()
needs_cli = pytest.mark.skipif(REAL is None, reason="the HyperFrames CLI isn't installed (Set up graphics)")


# ── the kit ────────────────────────────────────────────────────────

def test_the_kit_has_the_font_gsap_with_its_licence_tokens_and_icons():
    font = KIT / "fonts" / "Outfit-Variable.ttf"
    panel_font = Path(__file__).parents[2] / "extension" / "client" / "src" / "fonts" / "Outfit-Variable.ttf"
    assert font.read_bytes()[:4] == b"\x00\x01\x00\x00"
    if panel_font.is_file():
        assert font.read_bytes() == panel_font.read_bytes()  # the panel's own copy
    gsap = (KIT / "gsap.min.js").read_bytes()
    assert gsap.startswith(b"/*!\n * GSAP 3.14.2")
    assert hashlib.sha256(gsap).hexdigest() in (KIT / "GSAP-LICENSE.txt").read_text()
    assert "standard-license" in (KIT / "GSAP-LICENSE.txt").read_text()
    tokens = (KIT / "tokens.css").read_text()
    for colour in ("#112A33", "#009BD0", "#FF7A51", "#D06F9B", "#FFFFFF", "#F8F9FB"):
        assert colour in tokens
    icons = sorted(p.stem for p in (KIT / "icons").glob("*.svg"))
    assert len(icons) >= 12 and {"check", "shield", "mail", "lock", "user", "server"} <= set(icons)
    for p in (KIT / "icons").glob("*.svg"):
        assert p.read_text().startswith("<svg") and "http://www.w3.org/2000/svg" in p.read_text()


@pytest.mark.parametrize("kind", graphics.KINDS)
def test_each_starter_keeps_the_composition_contract(kind):
    html = STARTERS[kind]
    assert 'data-composition-id="main"' in html and 'window.__timelines["main"] = tl' in html
    assert "gsap.timeline({ paused: true })" in html
    assert '<script src="assets/gsap.min.js"></script>' in html
    assert '<link rel="stylesheet" href="assets/tokens.css" />' in html
    # The font is declared inline (HyperFrames rewrites urls in inline styles only) and is the only family.
    style = html.split("<style>", 1)[1].split("</style>", 1)[0]
    assert 'src: url("assets/fonts/Outfit-Variable.ttf")' in style
    assert set(re.findall(r"font-family:\s*([^;]+);", style)) == {'"Outfit"'}
    assert "http://" not in html.replace("http://www.w3.org", "") and "https://" not in html  # offline
    for banned in ("Math.random", "Date.now", "performance.now", "<br", "autoAlpha", "fetch("):
        assert banned not in html
    assert f'data-duration="{DEFAULT_DURATION[kind]}"' in html
    assert 'class="clip"' in html


@pytest.mark.parametrize("kind", graphics.KINDS)
def test_each_starter_declares_variables_with_defaults(kind):
    raw = re.search(r"data-composition-variables='(.*?)'>", STARTERS[kind], re.S).group(1)
    variables = json.loads(raw)
    assert variables and all({"id", "type", "label", "default"} <= set(v) for v in variables)
    assert "accent" in {v["id"] for v in variables}
    for v in variables:
        if v["type"] == "enum":
            assert v["default"] in [o["value"] for o in v["options"]]


@pytest.mark.parametrize("kind", graphics.KINDS)
def test_each_starter_animates_in_on_brand_and_out_before_the_end(kind):
    html = STARTERS[kind]
    eases = re.findall(r'ease: "([^"]+)"', html)
    assert "power3.out" in eases and any(e.endswith(".in") for e in eases)  # an entry and an exit
    entries = [float(d) for d in re.findall(r'duration: (0\.\d+), ease: "power3\.out"', html)]
    assert entries and all(0.4 <= d <= 0.6 for d in entries)
    assert "Number(root.dataset.duration)" in html or 'getElementById("root").dataset.duration' in html
    sizes = [int(s) for s in re.findall(r"font-size: (\d+)px", html)]
    assert sizes and min(sizes) >= 30
    assert "120px" in html  # safe margin


def test_the_card_covers_list_steps_comparison_and_chart():
    raw = re.search(r"data-composition-variables='(.*?)'>", STARTERS["card"], re.S).group(1)
    mode = next(v for v in json.loads(raw) if v["id"] == "mode")
    assert [o["value"] for o in mode["options"]] == ["list", "steps", "comparison", "chart"]


def test_the_explainer_uses_kit_icons_only():
    html = STARTERS["explainer-scene"]
    names = json.loads(re.search(r"const ICONS = (\[.*?\]);", html, re.S).group(1))
    assert sorted(names) == sorted(p.stem for p in (KIT / "icons").glob("*.svg"))


def test_starters_read_back_through_read_graphic():
    e = graphics.Engine()
    for kind in graphics.KINDS:
        assert e.read("", f"starter-{kind}")["html"] == STARTERS[kind]


# ── real check + render (slow) ─────────────────────────────────────

def _probe(path: Path) -> dict:
    r = subprocess.run([audio.find_tool("ffprobe"), "-v", "error", "-show_entries",
                        "stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate:format=duration",
                        "-of", "json", str(path)], capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


def _alpha(path: Path, at: float) -> bytes:
    r = subprocess.run([audio.find_tool("ffmpeg"), "-v", "error", "-ss", f"{at}", "-i", str(path), "-frames:v", "1",
                        "-vf", "alphaextract,scale=96:54", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                       capture_output=True, check=True)
    return r.stdout


def _alpha_used(path: Path, duration: float) -> bool:
    """The alpha channel carries the graphic: across the clip some pixels are see-through and some solid."""
    frames = [_alpha(path, t) for t in (0.1, 0.3, min(1.5, duration / 2), duration - 0.3)]
    return min(min(f) for f in frames) < 16 and max(max(f) for f in frames) > 240


@pytest.fixture
def real_engine():
    return graphics.Engine(prefix=REAL)


@pytest.fixture
def project(tmp_path):
    folder = tmp_path / "Real Project"
    folder.mkdir()
    return str(folder / "Edit.prproj")


@pytest.mark.slow
@needs_cli
@pytest.mark.parametrize("kind", graphics.KINDS)
def test_each_starter_passes_check_and_renders_a_silent_transparent_mov(real_engine, project, kind):
    d = DEFAULT_DURATION[kind]
    out = real_engine.make(project_path=project, slug=f"real-{kind}", kind=kind, duration_s=d, html=STARTERS[kind],
                           width=1920, height=1080, timebase="10160640000")  # 25 fps
    assert out["ok"] is True, out
    assert out["warnings"] == []
    info = _probe(Path(out["path"]))
    streams = info["streams"]
    assert [s["codec_type"] for s in streams] == ["video"]  # no audio stream
    v = streams[0]
    assert (v["codec_name"], v["pix_fmt"], v["width"], v["height"]) == ("prores", "yuva444p12le", 1920, 1080)
    assert v["r_frame_rate"] == "25/1"
    assert abs(float(info["format"]["duration"]) - d) < 0.05
    assert _alpha_used(Path(out["path"]), d)
    assert Path(out["preview"]).stat().st_size > 1000
    print(f"\n{kind}: {d}s rendered in {out['renderSeconds']}s")


@pytest.mark.slow
@needs_cli
def test_the_card_renders_vertical_at_29_97_with_variables(real_engine, project):
    out = real_engine.make(project_path=project, slug="real-vertical-card", kind="card", duration_s=5,
                           html=STARTERS["card"], width=1080, height=1920, timebase="8475667200",
                           variables={"mode": "chart", "title": "Spam caught", "items": "SPF=40|DKIM=25|DMARC=60"})
    assert out["ok"] is True and out["warnings"] == [], out
    v = _probe(Path(out["path"]))["streams"][0]
    assert (v["width"], v["height"], v["r_frame_rate"]) == (1080, 1920, "30000/1001")
    print(f"\nvertical card 5s at 29.97: {out['renderSeconds']}s")


@pytest.mark.slow
@needs_cli
def test_a_4k_sequence_renders_the_lower_third_at_3840(real_engine, project):
    out = real_engine.make(project_path=project, slug="real-4k-lower-third", kind="lower-third", duration_s=4,
                           html=STARTERS["lower-third"], width=3840, height=2160, timebase="8467200000")  # 30 fps
    assert out["ok"] is True, out
    info = _probe(Path(out["path"]))
    v = info["streams"][0]
    assert [s["codec_type"] for s in info["streams"]] == ["video"]
    assert (v["width"], v["height"], v["pix_fmt"], v["r_frame_rate"]) == (3840, 2160, "yuva444p12le", "30/1")
    print(f"\n4K lower third 4s at 30: {out['renderSeconds']}s")


@pytest.mark.slow
@needs_cli
def test_outfit_comes_from_the_kit_not_a_download(real_engine, project):
    out = real_engine.make(project_path=project, slug="real-font", kind="lower-third", duration_s=2,
                           html=STARTERS["lower-third"], width=1920, height=1080, fps=25)
    vdir = Path(out["html"]).parent
    node = real_engine.status()["node"]["path"]
    r = real_engine.run([node, str(real_engine.cli_path()), "check", "--json", "."], cwd=vdir,
                        env=real_engine.env(node), timeout=120)
    assert json.loads(r.stdout)["ok"] is True
    assert 'for "Outfit"' not in r.stderr  # no Google Fonts fetch: the @font-face file was used
    lint = json.loads(r.stdout)["lint"]["findings"]
    assert not [f for f in lint if "font" in f.get("code", "")]
