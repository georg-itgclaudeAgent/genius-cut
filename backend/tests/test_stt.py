import os
from pathlib import Path

import pytest

from geniuscut import stt

FIXTURE = Path(__file__).parent / "fixtures" / "speech.wav"
# Small model keeps the suite fast; the real service uses large-v3 (see stt.model_for).
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


def test_model_follows_the_device(monkeypatch):
    monkeypatch.delenv("GENIUSCUT_WHISPER_MODEL", raising=False)
    assert stt.model_for("cuda") == "large-v3"
    assert stt.model_for("cpu") == "large-v3-turbo"


def test_env_override_wins_on_any_device(monkeypatch):
    monkeypatch.setenv("GENIUSCUT_WHISPER_MODEL", "tiny")
    assert stt.model_for("cuda") == "tiny" and stt.model_for("cpu") == "tiny"


def test_cuda_failure_falls_back_to_cpu_with_the_cpu_model(monkeypatch):
    # Review Focus 4: an NVIDIA GPU with an old driver installs the cuda runtime, then
    # CUDA fails at load. The CPU fallback must use turbo, not large-v3.
    monkeypatch.delenv("GENIUSCUT_WHISPER_MODEL", raising=False)
    made = []

    def factory(name, device, compute_type):
        made.append((name, device))
        if device == "cuda":
            raise RuntimeError("CUDA driver version is insufficient")
        return FakeModel(name, device, compute_type)

    t = stt.FasterWhisperTranscriber(model_factory=factory, cuda_ready=lambda: True, warm_up=False)
    assert made == [("large-v3", "cuda"), ("large-v3-turbo", "cpu")]
    assert t.device == "cpu" and t.model_name == "large-v3-turbo"


class _Seg:
    def __init__(self, words):
        self.words = words


class _W:
    def __init__(self, word, start, end):
        self.word, self.start, self.end = word, start, end


def test_a_gpu_failure_mid_request_uses_the_cpu_for_that_request_only(tmp_path, caplog):
    # Checkpoint B (2026-10-07): a 1 h 30 min clip failed on the GPU. The fallback then stayed on
    # the slow CPU model for every later request, and the GPU's error was never logged.
    made, gpu_calls = [], []

    class GPU:
        def transcribe(self, audio, **kw):
            gpu_calls.append(1)
            if len(gpu_calls) == 1:
                raise RuntimeError("CUDA failed with error out of memory")
            return iter([_Seg([_W(" gpu", 0.0, 0.5)])]), None

    class CPU:
        def transcribe(self, audio, **kw):
            return iter([_Seg([_W(" cpu", 0.0, 0.5)])]), None

    def factory(name, device, compute_type):
        made.append((name, device))
        return GPU() if device == "cuda" else CPU()

    t = stt.FasterWhisperTranscriber(model_factory=factory, cuda_ready=lambda: True, warm_up=False)
    wav = _silent_wav(tmp_path)
    with caplog.at_level("WARNING"):
        assert [w.w for w in t.transcribe(wav)] == ["cpu"]
    assert "out of memory" in caplog.text
    assert t.device == "cuda"
    assert [w.w for w in t.transcribe(wav)] == ["gpu"]  # the next request is back on the GPU
    assert [d for _, d in made].count("cpu") == 1      # the CPU model is loaded once, then reused


def test_model_is_cached_asks_without_going_online(monkeypatch):
    seen = {}

    def fake_download(name, local_files_only=False, **kw):
        seen["local_only"] = local_files_only
        raise OSError("not in the cache")

    monkeypatch.setattr("faster_whisper.utils.download_model", fake_download)
    assert stt.model_is_cached("large-v3") is False and seen["local_only"] is True
    monkeypatch.setattr("faster_whisper.utils.download_model", lambda name, **kw: "C:/cache/large-v3")
    assert stt.model_is_cached("large-v3") is True


def test_a_cached_model_loads_without_checking_online(monkeypatch):
    got = {}

    class FakeWhisper:
        def __init__(self, name, **kw):
            got.update(kw)

    monkeypatch.setattr("faster_whisper.WhisperModel", FakeWhisper)
    monkeypatch.setattr(stt, "model_is_cached", lambda name: True)
    stt._whisper_model("large-v3", device="cuda", compute_type="float16")
    assert got["local_files_only"] is True
    monkeypatch.setattr(stt, "model_is_cached", lambda name: False)
    stt._whisper_model("large-v3", device="cuda", compute_type="float16")
    assert got["local_files_only"] is False
