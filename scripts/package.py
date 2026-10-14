"""Build the Genius Cut release zip that Genius Installer Manager installs.

    python scripts/package.py 0.1.0            # writes dist/genius-cut-0.1.0.zip
    python scripts/package.py 0.1.0 --check    # guards only, no zip

The zip root is the extension folder itself (CSXS/, client/dist/, host/, backend/), which
the installer extracts into %APPDATA%/Adobe/CEP/extensions/com.attract.genius-cut/.

Guards (each fails the build with a message):
  - the manifest's ExtensionBundleId is com.attract.genius-cut (the installer refuses others);
  - ExtensionBundleVersion equals the release version (the installer reads it to detect
    what's installed; a mismatch means every install keeps offering the same "update");
  - the client has been built;
  - the built client has no Claude assistant in it: no file under extension/client/dist may contain
    the bridge marker `gcut-assistant-bridge` (the bridge's reply header, compiled in only with
    VITE_GENIUSCUT_CLAUDE=1, however that flag got set). Personal builds are never packaged.

The assistant's host toolbox (the gcutTool* functions) is part of extension/host/index.jsx and is
packaged with it: editors' panels call it through the backend's agent. The personal door to it (the
HTTP bridge above, and mcp/) is never part of the package.

Prints, for CI:
  preview=true|false          — a preview build (VITE_GENIUSCUT_PREVIEW=1 in
                                extension/client/.env.production): sample data, no backend;
                                the backend is left out of the zip, and it's a normal release.
  bundled_runtime=true|false  — whether a Python runtime is inside the backend (Task 17). A
                                live build without one can't run on a clean machine, so CI
                                publishes it as a pre-release, which the installer ignores.
"""

import argparse
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
BACKEND = ROOT / "backend"
BUNDLE_ID = "com.attract.genius-cut"
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")

BRIDGE_MARKER = b"gcut-assistant-bridge"

BACKEND_SKIP_DIRS = {".venv", "tests", "__pycache__", ".pytest_cache"}
BACKEND_SKIP_SUFFIXES = {".pyc", ".wav", ".log"}


def fail(msg: str) -> None:
    print(f"package: {msg}", file=sys.stderr)
    sys.exit(1)


def check(version: str) -> None:
    if not SEMVER.match(version):
        fail(f"version {version!r} isn't X.Y.Z")
    manifest = (EXT / "CSXS" / "manifest.xml").read_text(encoding="utf-8")
    bundle = re.search(r'ExtensionBundleId="([^"]+)"', manifest)
    if not bundle or bundle.group(1) != BUNDLE_ID:
        fail(f"manifest ExtensionBundleId must be {BUNDLE_ID}, found {bundle.group(1) if bundle else 'none'}")
    ver = re.search(r'ExtensionBundleVersion="([^"]+)"', manifest)
    if not ver or ver.group(1) != version:
        fail(f"manifest ExtensionBundleVersion is {ver.group(1) if ver else 'missing'}, but the release is {version}. "
             "Bump extension/CSXS/manifest.xml first.")
    if not (EXT / "client" / "dist" / "index.html").exists():
        fail("extension/client/dist is missing. Run `npm ci && npm run build` in extension/client.")
    flagged = assistant_files()
    if flagged:
        fail("extension/client/dist contains the Claude assistant (the bridge marker "
             f"{BRIDGE_MARKER.decode()!r} is in {', '.join(flagged)}). This is a personal build "
             "(VITE_GENIUSCUT_CLAUDE=1, e.g. from extension/client/.env.production.local). Remove that "
             "setting and rebuild before packaging.")


def assistant_files() -> list[str]:
    """The dist files (relative paths) that contain the bridge marker, i.e. a build with the assistant."""
    dist = EXT / "client" / "dist"
    return [p.relative_to(dist).as_posix() for p in sorted(dist.rglob("*"))
            if p.is_file() and BRIDGE_MARKER in p.read_bytes()]


def preview_build() -> bool:
    env = EXT / "client" / ".env.production"
    return env.exists() and re.search(r"^VITE_GENIUSCUT_PREVIEW=1\s*$", env.read_text(encoding="utf-8"), re.M) is not None


def bundled_runtime() -> bool:
    return (BACKEND / "python" / "python.exe").exists()


def files(include_backend: bool):
    for sub in ("CSXS", "host", "client/dist"):
        for p in sorted((EXT / sub).rglob("*")):
            arc = p.relative_to(EXT).as_posix()
            if p.is_file() and not p.name.endswith(".map"):
                yield p, arc
    if not include_backend:
        return
    for p in sorted(BACKEND.rglob("*")):
        rel = p.relative_to(BACKEND)
        if p.is_file() and not (set(rel.parts) & BACKEND_SKIP_DIRS) and p.suffix not in BACKEND_SKIP_SUFFIXES:
            yield p, "backend/" + rel.as_posix()


def build(version: str, include_backend: bool) -> Path:
    out = ROOT / "dist" / f"genius-cut-{version}.zip"
    out.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for src, arc in files(include_backend):
            z.write(src, arc)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("version")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    check(args.version)
    preview = preview_build()
    print(f"preview={'true' if preview else 'false'}")
    print(f"bundled_runtime={'true' if bundled_runtime() else 'false'}")
    if not args.check:
        print(f"zip={build(args.version, include_backend=not preview).relative_to(ROOT).as_posix()}")


if __name__ == "__main__":
    main()
