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
