"""Build a Genius Cut runtime: embeddable Python + backend deps, trimmed, LZMA-zipped.

    python scripts/build_runtime.py cuda 1.0.0      # NVIDIA flavour
    python scripts/build_runtime.py cpu 1.0.0       # no NVIDIA libraries

Must run on Windows x64 with the same Python minor version the runtime targets (3.14),
because pip resolves wheels for the running interpreter.
"""

import argparse
import hashlib
import io
import platform
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TRIM_FILE = Path(__file__).resolve().parent / "runtime_trim.txt"


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
