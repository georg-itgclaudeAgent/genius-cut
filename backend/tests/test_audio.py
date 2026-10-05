import subprocess
from pathlib import Path

import pytest

from geniuscut.audio import FfmpegError, extract_span, find_tool, probe_duration


@pytest.fixture
def five_second_source(tmp_path) -> Path:
    src = tmp_path / "source.mp4"
    subprocess.run(
        [find_tool("ffmpeg"), "-nostdin", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
         "-f", "lavfi", "-i", "color=c=black:s=320x240:d=5", "-shortest", "-c:v", "mpeg4", "-c:a", "aac",  # native encoders: the bundled LGPL ffmpeg has no libx264
         str(src)],
        check=True, capture_output=True,
    )
    return src


def test_extracts_exactly_the_requested_span_as_16k_mono(five_second_source, tmp_path):
    wav = extract_span(five_second_source, 1.25, 3.75, out_dir=tmp_path)
    assert wav.suffix == ".wav"
    assert abs(probe_duration(wav) - 2.5) < 0.05
    info = subprocess.run(
        [find_tool("ffprobe"), "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=sample_rate,channels", "-of", "csv=p=0", str(wav)],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    assert info == "16000,1"


def test_prefers_the_ffmpeg_bundled_in_the_runtime(tmp_path, monkeypatch):
    # The shipped runtime carries ffmpeg at <runtime>/ffmpeg/bin; editors have no other copy.
    bundled = tmp_path / "ffmpeg" / "bin"
    bundled.mkdir(parents=True)
    (bundled / "ffprobe.exe").write_bytes(b"")
    monkeypatch.delenv("GENIUSCUT_FFMPEG_DIR", raising=False)
    monkeypatch.setattr("sys.prefix", str(tmp_path))
    assert find_tool("ffprobe") == str(bundled / "ffprobe.exe")


def test_missing_source_raises_with_ffmpeg_stderr(tmp_path):
    with pytest.raises(FfmpegError) as e:
        extract_span(tmp_path / "nope.mp4", 0, 1, out_dir=tmp_path)
    assert "nope.mp4" in str(e.value)


def test_rejects_an_empty_or_backwards_span(five_second_source, tmp_path):
    with pytest.raises(ValueError):
        extract_span(five_second_source, 2.0, 2.0, out_dir=tmp_path)
    with pytest.raises(ValueError):
        extract_span(five_second_source, 3.0, 1.0, out_dir=tmp_path)
