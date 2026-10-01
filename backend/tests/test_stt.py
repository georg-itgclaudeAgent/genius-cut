import os
from pathlib import Path

import pytest

from geniuscut import stt

FIXTURE = Path(__file__).parent / "fixtures" / "speech.wav"
# Small model keeps the suite fast; the real service uses large-v3 (see stt.DEFAULT_MODEL).
TEST_MODEL = os.environ.get("GENIUSCUT_TEST_WHISPER_MODEL", "tiny")


class FakeModel:
    def __init__(self, name, device, compute_type):
        self.device, self.compute_type = device, compute_type


def test_uses_gpu_when_runtime_present_and_model_loads():
    t = stt.FasterWhisperTranscriber("x", model_factory=FakeModel, cuda_ready=lambda: True, warm_up=False)
    assert t.device == "cuda"
    assert t._model.compute_type == "float16"


def test_falls_back_to_cpu_int8_when_gpu_load_fails():
    def factory(name, device, compute_type):
        if device == "cuda":
            raise RuntimeError("Library cublas64_12.dll is not found")
        return FakeModel(name, device, compute_type)

    t = stt.FasterWhisperTranscriber("x", model_factory=factory, cuda_ready=lambda: True, warm_up=False)
    assert t.device == "cpu"
    assert t._model.compute_type == "int8"
    assert "cublas64_12" in t.cuda_error


def test_never_tries_gpu_without_the_runtime_dlls():
    # Missing cuDNN can hard-crash the process on first inference instead of raising,
    # so without the DLLs the GPU must not be attempted at all.
    tried = []

    def factory(name, device, compute_type):
        tried.append(device)
        return FakeModel(name, device, compute_type)

    t = stt.FasterWhisperTranscriber("x", model_factory=factory, cuda_ready=lambda: False, warm_up=False)
    assert tried == ["cpu"]
    assert t.device == "cpu"


def test_bundled_cuda_runtime_is_loadable():
    assert stt.cuda_runtime_available(), "nvidia-cublas-cu12 / nvidia-cudnn-cu12 DLLs not found in the venv"


@pytest.mark.slow
def test_transcribes_real_speech_into_ordered_words():
    t = stt.FasterWhisperTranscriber(TEST_MODEL)
    words = t.transcribe(FIXTURE)
    assert len(words) >= 10
    assert all(w.end > w.start for w in words)
    assert all(a.start <= b.start for a, b in zip(words, words[1:]))
    text = " ".join(w.w.lower() for w in words)
    assert "workspace" in text and "licensing" in text


def _silent_wav(tmp_path):
    import wave
    p = tmp_path / "s.wav"
    with wave.open(str(p), "wb") as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(16000); f.writeframes(b"\x00\x00" * 1600)
    return p


class RecordingModel:
    def __init__(self, name, device, compute_type):
        self.kwargs = None

    def transcribe(self, audio, **kw):
        self.kwargs = kw
        return iter([]), None


def test_transcribes_verbatim_so_fillers_are_kept(tmp_path, monkeypatch):
    # Whisper tidies away "um"/"uh" by default; on a real clip that was 0 fillers vs 11 in 2 min.
    monkeypatch.delenv("GENIUSCUT_VERBATIM", raising=False)
    t = stt.FasterWhisperTranscriber("x", model_factory=RecordingModel, cuda_ready=lambda: False, warm_up=False)
    t.transcribe(_silent_wav(tmp_path))
    prompt = t._model.kwargs.get("initial_prompt") or ""
    assert "um" in prompt.lower() and "uh" in prompt.lower()
    assert t._model.kwargs["word_timestamps"] is True


def test_verbatim_prompt_can_be_switched_off(tmp_path, monkeypatch):
    monkeypatch.setenv("GENIUSCUT_VERBATIM", "0")
    t = stt.FasterWhisperTranscriber("x", model_factory=RecordingModel, cuda_ready=lambda: False, warm_up=False)
    t.transcribe(_silent_wav(tmp_path))
    assert "initial_prompt" not in t._model.kwargs
