import asyncio
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import numpy as np

from .model_runtime import DecodeResult, LanguageEvidence, ModelRuntime
from .settings import SAMPLE_RATE
from .streaming import RollingAudio, Scope, Snapshot, StreamingTranscript


@dataclass(frozen=True)
class Job:
    epoch: int
    scope: Scope
    snapshot: Snapshot
    first: bool = False
    anchor: dict[str, Any] | None = None
    flush: bool = False
    language: str | None = None


def snapshot_video_time(snapshot: Snapshot) -> float:
    """Video time at buffer head, replacing per-frame videoTimeAtCapture."""
    if not snapshot.anchors:
        return 0.0
    return snapshot.anchors[-1].video


class CaptionSession:
    def __init__(self, runtime: ModelRuntime, send: Callable[[dict[str, Any]], Awaitable[None]],
                 window_payload: Callable[..., dict[str, Any] | None],
                 latency_log: Callable[..., None] | None = None):
        self.runtime = runtime
        self.send = send
        self.window_payload = window_payload
        self.latency_log = latency_log
        self.last_flushed_end = -1
        self.scope = Scope()
        self.epoch = 0
        self.closed = False
        self.paused = False
        self.language = LanguageEvidence()
        self.rolling = RollingAudio(runtime.settings.max_buffer_samples)
        self.transcript = StreamingTranscript(self.scope, runtime.settings.max_words_per_caption)
        self.pending: Job | None = None
        self.worker: asyncio.Task | None = None
        self.first = True
        self.window_audio = np.empty(0, dtype=np.float32)
        self.window_anchor: dict[str, Any] | None = None
        # False when window_audio is only overlap; flushing then produces negative video times rejected by backend (Issue 5.41).
        self.window_dirty = False
        self.last_seq: int | None = None

    def reset(self, scope: Scope) -> None:
        self.scope = scope
        self.epoch += 1
        self.pending = None
        self.rolling = RollingAudio(self.runtime.settings.max_buffer_samples)
        self.transcript = StreamingTranscript(scope, self.runtime.settings.max_words_per_caption)
        self.window_audio = np.empty(0, dtype=np.float32)
        self.window_anchor = None
        self.window_dirty = False
        self.first = True
        self.last_seq = None
        self.last_flushed_end = -1
        self.paused = False
        self.language.reset()

    def accept_scope(self, metadata: dict[str, Any]) -> bool:
        incoming = Scope.parse(metadata, self.scope)
        if incoming.sessionId == self.scope.sessionId and incoming.generation < self.scope.generation:
            return False
        if (incoming.sessionId == self.scope.sessionId and
                incoming.generation == self.scope.generation and incoming.sourceId != self.scope.sourceId and
                self.scope.sessionId != "legacy"):
            return False
        if incoming != self.scope:
            self.reset(incoming)
        return True

    def control(self, metadata: dict[str, Any]) -> None:
        if not self.accept_scope(metadata):
            return
        kind = metadata.get("type")
        if kind in {"reset", "seek", "source-switch"}:
            # Scope already reset in accept_scope; retransmit control must not lower revision.
            if self.scope.sessionId == "legacy":
                self.reset(self.scope)
        elif kind == "source-language":
            language = metadata.get("language")
            if language is not None and (not isinstance(language, str) or not language.isalpha() or len(language) > 3):
                raise ValueError("Invalid source language")
            if language != self.language.selected:
                self.reset(self.scope)
                self.language.selected = language
        elif kind == "playback":
            state = metadata.get("state")
            if state in {"paused", "ended"}:
                self.paused = True
                self.flush()
            elif state == "playing":
                self.paused = False

    def audio(self, audio: np.ndarray, metadata: dict[str, Any]) -> None:
        if self.closed or not self.accept_scope(metadata) or self.paused:
            return
        seq = metadata.get("seq")
        if isinstance(seq, int):
            if self.last_seq is not None and seq <= self.last_seq:
                return
            self.last_seq = seq
        if self.runtime.settings.mode == "streaming":
            if len(audio) != SAMPLE_RATE or metadata.get("sampleRate", SAMPLE_RATE) != SAMPLE_RATE:
                raise ValueError("Streaming audio must be 16000 mono PCM samples")
            self.rolling.append(audio, metadata)
            self.submit(Job(self.epoch, self.scope, self.rolling.snapshot(), language=self.language.decode_language))
        else:
            if self.window_anchor is None:
                self.window_anchor = dict(metadata)
            self.window_audio = np.concatenate((self.window_audio, audio))
            self.window_dirty = True
            size = (2 if self.first else 3) * SAMPLE_RATE
            if len(self.window_audio) >= size:
                snapshot = Snapshot(self.window_audio[:size].copy(), 0, ())
                self.submit(Job(self.epoch, self.scope, snapshot, self.first,
                                self.window_anchor, language=self.language.decode_language))
                self.window_audio = self.window_audio[-int(1.5 * SAMPLE_RATE):]
                self.window_anchor = None
                self.window_dirty = False
                self.first = False

    def flush(self) -> None:
        if (self.runtime.settings.mode == "streaming" and len(self.rolling.audio) and
                self.last_flushed_end != self.rolling.end):
            self.last_flushed_end = self.rolling.end
            self.submit(Job(self.epoch, self.scope, self.rolling.snapshot(), flush=True,
                            language=self.language.decode_language))
        elif len(self.window_audio) and self.window_dirty:
            self.submit(Job(self.epoch, self.scope, Snapshot(self.window_audio.copy(), 0, ()),
                            self.first, self.window_anchor, True, self.language.decode_language))
            self.window_audio = np.empty(0, dtype=np.float32)
            self.window_anchor = None
            self.window_dirty = False
            self.first = True

    def submit(self, job: Job) -> None:
        # Socket always drains; latest pending snapshot replaces previous, no per-frame queue.
        self.pending = job
        if self.worker is None or self.worker.done():
            self.worker = asyncio.create_task(self._consume())

    async def _consume(self) -> None:
        while self.pending is not None and not self.closed:
            job = self.pending
            try:
                # Snapshot taken only when model's turn; waiting connections still coalesce new frames.
                async with self.runtime.inference_gate:
                    if self.closed or self.pending is None:
                        continue
                    job, self.pending = self.pending, None
                    if job.epoch != self.epoch:
                        continue
                    started = time.perf_counter()
                    result = await self.runtime.decode(job.snapshot.audio, job.language)
                    elapsed = time.perf_counter() - started
                if self.closed or job.epoch != self.epoch or job.scope != self.scope:
                    continue
                self.language.observe(result)
                if self.runtime.settings.mode == "streaming":
                    message = self.transcript.update(result, job.snapshot, job.flush)
                    await self.send(message)
                    # Keep 1s context before committed prefix; trim doesn't change sample clock.
                    before = self.transcript.committed_end - SAMPLE_RATE
                    self.rolling.trim(before)
                    if job.flush and self.pending is None:
                        end = self.rolling.end
                        self.rolling = RollingAudio(self.runtime.settings.max_buffer_samples)
                        self.rolling.start = self.rolling.end = end
                    record = {
                        "mode": "streaming",
                        "samples": len(job.snapshot.audio),
                        "videoTime": snapshot_video_time(job.snapshot),
                        "source": job.scope.sourceId,
                        # Streaming has no separate "first" window; rolling buffer fills gradually, so every turn is steady.
                        "kind": "steady",
                        "revision": self.transcript.revision,
                        "flush": job.flush,
                    }
                else:
                    message = self.window_payload(result, job.anchor, job.first, job.scope)
                    if message is not None:
                        await self.send(message)
                    record = {
                        "mode": "windowed",
                        "samples": len(job.snapshot.audio),
                        "videoTime": job.anchor.get("videoTimeAtCapture", 0.0) if job.anchor else 0.0,
                        "source": job.anchor.get("sourceId") if job.anchor else None,
                        "kind": "catchup" if job.first else "steady",
                        "revision": None,
                        "flush": job.flush,
                    }
                if self.latency_log is not None:
                    self.latency_log(record, elapsed, started)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                if not self.closed and job.epoch == self.epoch:
                    await self.send({"type": "error", **self.scope.wire(),
                                     "message": f"ASR failed ({type(error).__name__})"})

    async def close(self) -> None:
        self.closed = True
        self.epoch += 1
        self.pending = None
        if self.worker is not None:
            self.worker.cancel()
            try:
                await self.worker
            except asyncio.CancelledError:
                pass
