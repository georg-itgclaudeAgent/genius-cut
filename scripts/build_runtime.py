"""Build a Genius Cut runtime: embeddable Python + backend deps, trimmed, LZMA-zipped.

    python scripts/build_runtime.py cuda 1.0.0      # NVIDIA flavour
    python scripts/build_runtime.py cpu 1.0.0       # no NVIDIA libraries

Must run on Windows x64 with the same Python minor version the runtime targets (3.14),
because pip resolves wheels for the running interpreter.
"""

import argparse
import hashlib
import io
import os
import platform
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TRIM_FILE = Path(__file__).resolve().parent / "runtime_trim.txt"

# The MSVC C++ runtime ctranslate2 / onnxruntime link against. Embeddable Python ships only
# vcruntime140*.dll, so without these `import ctranslate2` fails on PCs that lack the
# VC++ 2015-2022 x64 Redistributable. Copied from the build machine next to python.exe.
MSVC_RUNTIME_DLLS = ("msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll",
                     "vcruntime140.dll", "vcruntime140_1.dll", "concrt140.dll")

# ffmpeg for audio extraction (editors have none). LGPL shared build of the 8.1 release
# branch, pinned by checksum. BtbN prunes old autobuilds: if this URL 404s, pick a current
# `win64-lgpl-shared-<ver>.zip` from github.com/BtbN/FFmpeg-Builds/releases and re-pin both.
FFMPEG_URL = ("https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-04-20-51/"
              "ffmpeg-n8.1.3-14-g330caae0c1-win64-lgpl-shared-8.1.zip")
FFMPEG_SHA256 = "68d53cc84f716c02853e2ea3ff5f1beaea590646cb6831e0a646d22208c97a83"


def patch_pth(text: str) -> str:
    """Embeddable Python only searches what its ._pth lists, and skips `site` unless asked."""
    lines = [l for l in text.splitlines() if l.strip() not in ("#import site", "import site", "Lib\\site-packages")]
    lines += ["Lib\\site-packages", "import site"]
    return "\n".join(lines) + "\n"


def load_trim_list() -> list[str]:
    return [l.strip() for l in TRIM_FILE.read_text(encoding="utf-8").splitlines() if l.strip() and not l.startswith("#")]


def trim(root: Path, names: list[str]) -> int:
    removed = 0
    wanted = set(names)
    for p in root.rglob("*.dll"):
        if p.name in wanted:
            removed += p.stat().st_size
            p.unlink()
    return removed


def copy_msvc_runtime(stage: Path, system32: Path) -> None:
    """Put the MSVC C++ runtime in the runtime root. The embeddable's own vcruntime copies are
    kept (they match its python.exe); msvcp*/concrt always come from the build machine."""
    missing = [n for n in MSVC_RUNTIME_DLLS if n.startswith("msvcp") and not (system32 / n).is_file()]
    if missing:
        raise SystemExit(f"{', '.join(missing)} not found in {system32}. Install the Microsoft "
                         "Visual C++ 2015-2022 x64 Redistributable on the build machine.")
    for n in MSVC_RUNTIME_DLLS:
        src, dst = system32 / n, stage / n
        if src.is_file() and (n.startswith(("msvcp", "concrt")) or not dst.exists()):
            shutil.copy2(src, dst)


def install_ffmpeg(data: bytes, expected_sha256: str, stage: Path) -> None:
    """Unpack ffmpeg.exe, ffprobe.exe, their DLLs and the licence to <stage>/ffmpeg."""
    if hashlib.sha256(data).hexdigest() != expected_sha256:
        raise SystemExit("The ffmpeg download failed its checksum; refusing to bundle it.")
    dest = stage / "ffmpeg"
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for name in z.namelist():
            rel = name.split("/", 1)[1] if "/" in name else ""
            keep = rel == "LICENSE.txt" or rel in ("bin/ffmpeg.exe", "bin/ffprobe.exe") or (
                rel.startswith("bin/") and rel.endswith(".dll"))
            if keep:
                out = dest / rel
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(z.read(name))


def fetch_ffmpeg(stage: Path) -> None:
    with urllib.request.urlopen(FFMPEG_URL) as r:
        install_ffmpeg(r.read(), FFMPEG_SHA256, stage)


def requirements_for(flavour: str) -> Path:
    return ROOT / "backend" / ("requirements.txt" if flavour == "cuda" else "requirements-runtime.txt")


def fetch_embeddable(dest: Path) -> None:
    ver = platform.python_version()
    url = f"https://www.python.org/ftp/python/{ver}/python-{ver}-embed-amd64.zip"
    with urllib.request.urlopen(url) as r:
        zipfile.ZipFile(io.BytesIO(r.read())).extractall(dest)
    pth = next(dest.glob("python3*._pth"))
    pth.write_text(patch_pth(pth.read_text(encoding="utf-8")), encoding="utf-8")


def build(flavour: str, version: str, out: Path) -> Path:
    stage = out / f"runtime-{flavour}"
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True)
    fetch_embeddable(stage)
    copy_msvc_runtime(stage, Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32")
    fetch_ffmpeg(stage)
    site = stage / "Lib" / "site-packages"
    subprocess.run([sys.executable, "-m", "pip", "install", "--no-compile", "--target", str(site),
                    "-r", str(requirements_for(flavour))], check=True)
    if flavour == "cuda":
        print(f"trimmed_mb={trim(stage, load_trim_list()) // 2**20}")
    zpath = out / f"genius-cut-runtime-{flavour}-{version}.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_LZMA) as z:
        for p in sorted(stage.rglob("*")):
            if p.is_file() and "__pycache__" not in p.parts:
                z.write(p, p.relative_to(stage).as_posix())
    digest = hashlib.sha256(zpath.read_bytes()).hexdigest()
    (zpath.parent / (zpath.name + ".sha256")).write_text(digest + "\n", encoding="utf-8")
    return zpath


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("flavour", choices=["cuda", "cpu"])
    ap.add_argument("version")
    ap.add_argument("--out", default=str(ROOT / "dist"))
    a = ap.parse_args()
    z = build(a.flavour, a.version, Path(a.out))
    print(f"zip={z.relative_to(ROOT).as_posix() if z.is_relative_to(ROOT) else z}")
    print(f"size_mb={z.stat().st_size // 2**20}")


if __name__ == "__main__":
    main()
