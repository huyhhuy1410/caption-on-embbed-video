import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Callable

import numpy as np

from .settings import Settings


@dataclass(frozen=True)
class DecodeResult:
    words: list[dict[str, Any]]
    language: str
    language_probability: float
    voiced: bool


def decode_waveform(model: Any, audio: np.ndarray, language: str | None) -> DecodeResult:
    # Generator runs inference; must consume in worker thread, not event loop.
    segments, info = model.transcribe(
        audio, language=language, beam_size=1, word_timestamps=True,
        vad_filter=True, condition_on_previous_text=False,
    )
    words: list[dict[str, Any]] = []
    speech = False
    for segment in segments:
        segment_words = list(segment.words or [])
        speech = speech or (bool(segment_words) and getattr(segment, "no_speech_prob", 0) < 0.6)
        for index, word in enumerate(segment_words):
            text = word.word.strip()
            if text:
                words.append({"w": text, "s": float(word.start), "e": float(word.end),
                              "c": float(word.probability),
                              "segmentEnd": index == len(segment_words) - 1})
    energy = float(np.sqrt(np.mean(np.square(audio)))) if len(audio) else 0.0
    voiced = speech and energy >= 0.002 and getattr(info, "duration_after_vad", 1.0) > 0
    return DecodeResult(words if voiced else [], info.language,
                        float(info.language_probability), voiced)


class ModelRuntime:
    def __init__(self, settings: Settings, factory: Callable[..., Any] | None = None):
        self.settings = settings
        self.factory = factory
        self.model: Any = None
        self.state = "loading"
        self.message = "Loading selected model; first use may download its weights"
        # Single worker serializes all model access, survives coroutine cancellation during inference.
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="caption-asr")
        self.load_task: asyncio.Task | None = None
        self.inference_gate = asyncio.Semaphore(1)
        self.closed = False

    def _load(self) -> None:
        try:
            factory = self.factory
            if factory is None:
                from faster_whisper import WhisperModel
                factory = WhisperModel
            self.model = factory(self.settings.model, device="cpu", compute_type="int8",
                                 num_workers=1, local_files_only=self.settings.local_files_only)
            self.state = "ready"
            self.message = ""
        except Exception as error:
            self.state = "error"
            self.message = f"Model load failed ({type(error).__name__}); check local cache/network and restart sidecar"

    def start(self) -> None:
        if self.load_task is None:
            self.load_task = asyncio.create_task(self._load_async())

    async def _load_async(self) -> None:
        await asyncio.get_running_loop().run_in_executor(self.executor, self._load)

    async def decode(self, audio: np.ndarray, language: str | None) -> DecodeResult:
        if self.state != "ready" or self.model is None:
            raise RuntimeError(f"Model is {self.state}")
        return await asyncio.get_running_loop().run_in_executor(
            self.executor, decode_waveform, self.model, audio, language,
        )

    def health(self) -> dict[str, str]:
        result = {"status": self.state, "service": "caption-ai-sidecar",
                  "model": self.settings.model, "mode": self.settings.mode}
        if self.message:
            result["message"] = self.message
        return result

    async def close(self) -> None:
        if self.load_task is not None:
            await self.load_task
        await asyncio.to_thread(self.executor.shutdown, wait=True, cancel_futures=True)
        self.model = None
        self.closed = True


class LanguageEvidence:
    def __init__(self) -> None:
        self.selected: str | None = None
        self.confirmed: str | None = None
        self.candidate: str | None = None
        self.count = 0

    @property
    def decode_language(self) -> str | None:
        return self.selected or self.confirmed

    def observe(self, result: DecodeResult) -> None:
        if self.selected or not result.voiced:
            return
        if result.language_probability < 0.8:
            self.candidate = None
            self.count = 0
            return
        if result.language == self.candidate:
            self.count += 1
        else:
            self.candidate = result.language
            self.count = 1
        if self.count >= 3:
            self.confirmed = self.candidate

    def reset(self, preserve_selection: bool = True) -> None:
        if not preserve_selection:
            self.selected = None
        self.confirmed = self.candidate = None
        self.count = 0
