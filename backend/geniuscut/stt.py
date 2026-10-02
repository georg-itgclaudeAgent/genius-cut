"""Word-level speech-to-text, on the local GPU when it can be, the CPU when it can't.

CTranslate2 4.x needs the CUDA 12 + cuDNN 9 runtime DLLs. They ship inside this
venv as NVIDIA's pip wheels (nvidia-cublas-cu12, nvidia-cudnn-cu12,
nvidia-cuda-runtime-cu12), so nothing is installed system-wide. A missing cuDNN can
hard-crash the process on first inference rather than raise, so the GPU is only
tried after the DLLs have been proven loadable, and a warm-up run surfaces any
remaining failure at startup instead of mid-request.
"""

import ctypes
import os
import sys
from pathlib import Path
from typing import Callable, Protocol

from geniuscut.models import Word


def model_for(device: str) -> str:
    """large-v3 on CUDA (keeps the most fillers); turbo on CPU (2.8x faster, half the disk)."""
    override = os.environ.get("GENIUSCUT_WHISPER_MODEL")
    if override:
        return override
    return "large-v3" if device == "cuda" else "large-v3-turbo"


# Whisper tidies "um"/"uh" out of transcripts unless shown disfluent speech first, and the
# cut proposer can't remove a filler it never sees. On a real 2-minute clip this took the
# um/uh count from 0 to 11 with the same words otherwise. Set GENIUSCUT_VERBATIM=0 to disable.
VERBATIM_PROMPT = "Umm, so, uh, let me think. Like, hmm... Okay, so, um, here's what I'm, uh, I'm thinking."


def _verbatim() -> bool:
    return os.environ.get("GENIUSCUT_VERBATIM", "1") != "0"
_REQUIRED_DLLS = ("cudart64_12.dll", "cublas64_12.dll", "cudnn64_9.dll", "cudnn_ops64_9.dll")


def _register_nvidia_dlls() -> None:
    """Make the venv's nvidia/*/bin folders visible to CTranslate2's DLL loader."""
    root = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
    if not root.is_dir():
        return
    for bin_dir in sorted(root.glob("*/bin")):
        os.add_dll_directory(str(bin_dir))
        os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ.get("PATH", "")


_register_nvidia_dlls()


def cuda_runtime_available() -> bool:
    try:
        for dll in _REQUIRED_DLLS:
            ctypes.WinDLL(dll)
    except (OSError, AttributeError):  # AttributeError: WinDLL doesn't exist off Windows
        return False
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


def read_wav_16k_mono(path: Path):
    """16-bit PCM, 16 kHz, mono WAV → float32 samples in [-1, 1]."""
    import wave

    import numpy as np

    with wave.open(str(path), "rb") as w:
        if (w.getframerate(), w.getnchannels(), w.getsampwidth()) != (16000, 1, 2):
            raise ValueError(
                f"{path}: expected 16 kHz mono 16-bit PCM, got {w.getframerate()} Hz, "
                f"{w.getnchannels()} ch, {8 * w.getsampwidth()}-bit")
        pcm = w.readframes(w.getnframes())
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0


class Transcriber(Protocol):
    device: str

    def transcribe(self, wav: Path) -> list[Word]: ...


def _whisper_model(name: str, device: str, compute_type: str):
    from faster_whisper import WhisperModel

    return WhisperModel(name, device=device, compute_type=compute_type)


class FasterWhisperTranscriber:
    """Load once at process start (first load downloads the model); reuse for every request."""

    def __init__(
        self,
        model_name: str | None = None,
        model_factory: Callable = _whisper_model,
        cuda_ready: Callable[[], bool] = cuda_runtime_available,
        warm_up: bool = True,
    ):
        self._factory = model_factory
        self._explicit = model_name
        self.cuda_error: str | None = None
        self.device = "cpu"
        self._model = None
        if cuda_ready():
            try:
                self.model_name = model_name or model_for("cuda")
                self._model = model_factory(self.model_name, device="cuda", compute_type="float16")
                if warm_up:
                    self._warm_up()
                self.device = "cuda"
            except Exception as e:  # noqa: BLE001 — any GPU failure means "use the CPU"
                self.cuda_error = str(e)
                self._model = None
        else:
            self.cuda_error = "CUDA 12 / cuDNN 9 runtime not available"
        if self._model is None:
            self.model_name = model_name or model_for("cpu")
            self._model = model_factory(self.model_name, device="cpu", compute_type="int8")

    def _warm_up(self) -> None:
        import numpy as np

        segments, _ = self._model.transcribe(np.zeros(16000, dtype=np.float32), language="en")
        list(segments)

    def transcribe(self, wav: Path) -> list[Word]:
        # Samples, not a path: faster-whisper 1.2.1 decodes files through PyAV with an
        # argument PyAV 19 removed. Our WAVs always come from audio.extract_span.
        samples = read_wav_16k_mono(wav)
        try:
            return self._words(samples)
        except Exception as e:  # noqa: BLE001
            if self.device != "cuda":
                raise
            # e.g. out of GPU memory while Premiere is using the same card.
            self.cuda_error = str(e)
            self.model_name = self._explicit or model_for("cpu")
            self._model = self._factory(self.model_name, device="cpu", compute_type="int8")
            self.device = "cpu"
            return self._words(samples)

    def _words(self, samples) -> list[Word]:
        extra = {"initial_prompt": VERBATIM_PROMPT} if _verbatim() else {}
        segments, _ = self._model.transcribe(samples, word_timestamps=True, vad_filter=True, **extra)
        words: list[Word] = []
        for seg in segments:
            for w in seg.words or []:
                text = w.word.strip()
                if text and w.end > w.start:
                    words.append(Word(w=text, start=round(w.start, 3), end=round(w.end, 3)))
        return words
