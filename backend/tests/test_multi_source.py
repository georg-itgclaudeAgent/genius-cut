import subprocess
import wave
from pathlib import Path

import pytest

from geniuscut import audio, trim
from geniuscut.models import CutSpan, TrimRequest, Word

WORDS = [Word(w="So,", start=0.0, end=0.3), Word(w="um,", start=0.5, end=0.8), Word(w="hello", start=1.0, end=1.4)]


class FakeTranscriber:
    device = "cuda"

    def transcribe(self, wav):
        self.wav = wav
        return WORDS


def test_old_single_clip_requests_still_work():
    r = TrimRequest(media_path="C:/a.mov", in_s=10.0, out_s=14.0, clip_start_s=100.0, prompt="x")
    assert r.duration_s == 4.0 and r.range_start_seq_s == 100.0
    assert [(s.media_path, s.in_s) for s in r.audio] == [("C:/a.mov", 10.0)]


def test_a_request_needs_at_least_one_audio_source_and_a_positive_duration():
    with pytest.raises(ValueError):
        TrimRequest(duration_s=4.0, audio=[])
    with pytest.raises(ValueError):
        TrimRequest(duration_s=0.0, audio=[{"media_path": "a", "in_s": 0}])


def _req(sources, **kw):
    return TrimRequest(duration_s=4.0, range_start_seq_s=100.0, audio=sources, cut_pauses=False, **kw)


def _run(tmp_path, req, seen):
    def fake_extract(media_path, in_s, out_s, out_dir=None):
        seen.append((media_path, in_s, out_s))
        out = Path(out_dir) / "span.wav"
        out.write_bytes(b"RIFF")
        return out

    def fake_mix(paths, out):
        seen.append(("mix", len(paths)))
        out.write_bytes(b"RIFF")
        return out

    cut = [CutSpan(start=0.5, end=0.8, text="um,", reason="filler")]
    return trim.run_trim(req, FakeTranscriber(), tmp_path, propose=lambda w, f, i: cut, extract=fake_extract,
                         refine=lambda c, w, d, env=None: c, mix=fake_mix)


def test_one_source_is_extracted_for_the_range_and_not_mixed(tmp_path):
    seen = []
    r = _run(tmp_path, _req([{"media_path": "C:/wide.mov", "in_s": 10.0}]), seen)
    assert seen == [("C:/wide.mov", 10.0, 14.0)]
    assert [(s.start, s.end) for s in r.kept_spans] == [(0.0, 0.5), (0.8, 4.0)]  # relative to the range
    assert [(c.start_seq_s, c.end_seq_s) for c in r.cuts] == [(100.5, 100.8)]


def test_several_sources_are_each_extracted_for_the_same_range_then_mixed(tmp_path):
    seen = []
    _run(tmp_path, _req([{"media_path": "C:/mic1.wav", "in_s": 3.0}, {"media_path": "C:/mic2.wav", "in_s": 7.5}]), seen)
    assert seen == [("C:/mic1.wav", 3.0, 7.0), ("C:/mic2.wav", 7.5, 11.5), ("mix", 2)]


def _tone(path, freq, seconds, amp):
    subprocess.run([audio.find_tool("ffmpeg"), "-nostdin", "-y", "-v", "error", "-f", "lavfi",
                    "-i", f"sine=frequency={freq}:duration={seconds}", "-af", f"volume={amp}",
                    "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(path)], check=True)
    return path


def test_mix_wavs_keeps_both_voices_at_full_level(tmp_path):
    a = _tone(tmp_path / "a.wav", 220, 2, 0.3)
    b = _tone(tmp_path / "b.wav", 330, 3, 0.3)
    out = audio.mix_wavs([a, b], tmp_path / "mix.wav")
    with wave.open(str(out)) as w:
        assert (w.getframerate(), w.getnchannels(), w.getsampwidth()) == (16000, 1, 2)
        assert abs(w.getnframes() / 16000 - 3.0) < 0.05  # as long as the longest input
    from geniuscut.stt import read_wav_16k_mono
    x = read_wav_16k_mono(out)
    # lavfi sine peaks at 0.125, x0.3 = 0.0375 per tone: summed ~0.075, a normalised (halved) mix would be ~0.0375
    assert abs(x[:16000]).max() > 0.06  # both tones present and not halved (normalize=0)


def test_a_part_range_source_is_extracted_for_its_part_and_placed_at_its_offset(tmp_path):
    seen = []
    req = TrimRequest(duration_s=10.0, range_start_seq_s=100.0, cut_pauses=False,
                      audio=[{"media_path": "C:/a.wav", "in_s": 3.0, "offset_s": 2.0, "duration_s": 6.0}])

    def fake_extract(media_path, in_s, out_s, out_dir=None):
        seen.append((media_path, in_s, out_s))
        out = Path(out_dir) / "span.wav"; out.write_bytes(b"RIFF"); return out

    def fake_place(wav, offset_s, total_s, out):
        seen.append(("place", offset_s, total_s)); out.write_bytes(b"RIFF"); return out

    trim.run_trim(req, FakeTranscriber(), tmp_path, propose=lambda w, f, i: [], extract=fake_extract,
                  refine=lambda c, w, d, env=None: c, mix=lambda p, o: p[0], place=fake_place)
    assert seen == [("C:/a.wav", 3.0, 9.0), ("place", 2.0, 10.0)]


def test_a_source_must_fit_inside_the_range():
    with pytest.raises(ValueError):
        TrimRequest(duration_s=10.0, audio=[{"media_path": "a", "in_s": 0, "offset_s": 5.0, "duration_s": 6.0}])


def test_a_part_range_source_is_padded_to_the_range(tmp_path):
    a = _tone(tmp_path / "a.wav", 220, 2, 0.3)
    out = audio.place_in_range(a, 3.0, 6.0, tmp_path / "placed.wav")
    from geniuscut.stt import read_wav_16k_mono
    x = read_wav_16k_mono(out)
    assert abs(len(x) / 16000 - 6.0) < 0.01
    assert abs(x[: 3 * 16000 - 800]).max() < 1e-3        # silence before the offset
    assert abs(x[3 * 16000 + 800: 5 * 16000 - 800]).max() > 0.02  # the tone, 3-5 s
    assert abs(x[5 * 16000 + 800:]).max() < 1e-3          # silence after it
