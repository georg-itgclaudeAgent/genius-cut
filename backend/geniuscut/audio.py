"""Extract exactly the span of a clip that sits on the timeline, as 16 kHz mono WAV.

ffmpeg is resolved explicitly rather than trusted to be on PATH, because a process
spawned by a CEP panel does not always inherit the user's PATH.
"""

import glob
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


class FfmpegError(RuntimeError):
    """ffmpeg/ffprobe failed. Carries stderr — a silent empty WAV is the worst outcome here."""


def find_tool(name: str) -> str:
    """`GENIUSCUT_FFMPEG_DIR/<name>.exe`, else the copy bundled in the runtime, else PATH,
    else a winget Gyan.FFmpeg install."""
    override = os.environ.get("GENIUSCUT_FFMPEG_DIR")
    for folder in ([Path(override)] if override else []) + [Path(sys.prefix) / "ffmpeg" / "bin"]:
        candidate = folder / f"{name}.exe"
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


def mix_wavs(paths: list[Path], out: Path) -> Path:
    """Mix 16 kHz mono WAVs into one, at full level (each presenter's mic as recorded), as long
    as the longest. For transcription only: the timeline's audio is never changed."""
    if len(paths) == 1:
        return Path(paths[0])
    cmd = [find_tool("ffmpeg"), "-nostdin", "-y", "-hide_banner", "-loglevel", "error"]
    for p in paths:
        cmd += ["-i", str(p)]
    cmd += ["-filter_complex", f"amix=inputs={len(paths)}:normalize=0:duration=longest",
            "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(out)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0 or not Path(out).exists():
        raise FfmpegError(f"ffmpeg could not mix the audio: {result.stderr.strip()}")
    return Path(out)


def place_in_range(wav: Path, offset_s: float, total_s: float, out: Path) -> Path:
    """Put a source's part at its place inside the range: silence before and after, exactly
    total_s long, so word times line up with the range for every source."""
    cmd = [find_tool("ffmpeg"), "-nostdin", "-y", "-hide_banner", "-loglevel", "error", "-i", str(wav),
           "-af", f"adelay={int(round(offset_s * 1000))}:all=1,apad,atrim=0:{total_s:.6f}",
           "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(out)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0 or not Path(out).exists():
        raise FfmpegError(f"ffmpeg could not place the audio in the range: {result.stderr.strip()}")
    return Path(out)
