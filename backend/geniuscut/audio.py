"""Extract exactly the span of a clip that sits on the timeline, as 16 kHz mono WAV.

ffmpeg is resolved explicitly rather than trusted to be on PATH, because a process
spawned by a CEP panel does not always inherit the user's PATH.
"""

import glob
import os
import shutil
import subprocess
import tempfile
from pathlib import Path


class FfmpegError(RuntimeError):
    """ffmpeg/ffprobe failed. Carries stderr — a silent empty WAV is the worst outcome here."""


def find_tool(name: str) -> str:
    """`GENIUSCUT_FFMPEG_DIR/<name>.exe`, else PATH, else a winget Gyan.FFmpeg install."""
    override = os.environ.get("GENIUSCUT_FFMPEG_DIR")
    if override:
        candidate = Path(override) / f"{name}.exe"
        if candidate.is_file():
            return str(candidate)
    on_path = shutil.which(name)
    if on_path:
        return on_path
    local = os.environ.get("LOCALAPPDATA", "")
    matches = sorted(glob.glob(os.path.join(
        local, "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg*", "ffmpeg-*", "bin", f"{name}.exe")))
    if matches:
        return matches[-1]
    raise FfmpegError(f"{name} not found. Install it (winget install Gyan.FFmpeg) or set GENIUSCUT_FFMPEG_DIR.")


def extract_span(media_path: Path | str, in_s: float, out_s: float, out_dir: Path | None = None) -> Path:
    """Write `[in_s, out_s)` of the media's first audio stream to a WAV and return its path.

    The caller owns the returned file (and `out_dir`, if it passed one).
    """
    if out_s <= in_s:
        raise ValueError(f"Empty or backwards span: in {in_s}s, out {out_s}s")
    out_dir = Path(out_dir) if out_dir else Path(tempfile.mkdtemp(prefix="geniuscut-"))
    out = out_dir / "span.wav"
    cmd = [
        find_tool("ffmpeg"), "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
        "-ss", f"{in_s:.6f}", "-to", f"{out_s:.6f}",  # before -i: fast input seek
        "-i", str(media_path),
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(out),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0 or not out.exists() or out.stat().st_size <= 44:
        raise FfmpegError(f"ffmpeg could not extract audio from {media_path}: {result.stderr.strip()}")
    return out


def probe_duration(path: Path | str) -> float:
    result = subprocess.run(
        [find_tool("ffprobe"), "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise FfmpegError(f"ffprobe failed on {path}: {result.stderr.strip()}")
    return float(result.stdout.strip())
