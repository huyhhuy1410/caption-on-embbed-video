from array import array
from contextlib import asynccontextmanager
import time
from typing import Any

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from .model_runtime import DecodeResult, ModelRuntime
from .session import CaptionSession
from .settings import SAMPLE_RATE, Settings
from .streaming import Scope

# Window invariants: catchup > overlap; window >= 2 * overlap (Issue 5.22/5.30).
WINDOW_SIZE = 3 * SAMPLE_RATE
OVERLAP_SIZE = int(1.5 * SAMPLE_RATE)
CATCHUP_WINDOW_SIZE = 2 * SAMPLE_RATE
MAX_BUFFER_SIZE = 12 * SAMPLE_RATE
MAX_WORDS_PER_CAPTION = 16

settings = Settings.from_env()
runtime = ModelRuntime(settings)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global runtime
    if runtime.closed:
        runtime = ModelRuntime(settings)
    runtime.start()
    try:
        yield
    finally:
        await runtime.close()


app = FastAPI(title="Caption AI Sidecar", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, str]:
    return runtime.health()


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    await websocket.send_json({"type": "status", "state": "listening"})
    session = CaptionSession(runtime, websocket.send_json, windowed_payload, log_latency)
    pending_metadata: dict[str, Any] | None = None
    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            if message.get("text") is not None:
                metadata = parse_metadata(message["text"])
                pending_metadata = None
                if metadata is None:
                    continue
                try:
                    if metadata.get("type") in {"reset", "seek", "source-switch", "source-language", "playback"}:
                        session.control(metadata)
                    elif metadata.get("type") == "audio" or "videoTimeAtCapture" in metadata:
                        pending_metadata = metadata
                except ValueError as error:
                    await websocket.send_json({"type": "error", "message": str(error)})
                continue
            audio_bytes = message.get("bytes")
            if audio_bytes is None or pending_metadata is None:
                continue
            metadata, pending_metadata = pending_metadata, None
            if runtime.state != "ready":
                await websocket.send_json({"type": "status", "state": runtime.state,
                                           "message": runtime.message})
                continue
            try:
                session.audio(bytes_to_float32(audio_bytes), metadata)
            except ValueError as error:
                await websocket.send_json({"type": "error", "message": str(error)})
    except WebSocketDisconnect:
        pass
    finally:
        await session.close()


def log_latency(record: dict[str, Any], whisper_seconds: float, window_started_at: float) -> None:
    """Log one LAT line per decode; kind separates steady vs catch-up; revision is streaming-only for analyze_latency.py correlation."""
    sent_at = time.perf_counter()
    window_seconds = record["samples"] / SAMPLE_RATE
    revision = record.get("revision")
    revision_field = f" revision={revision}" if revision is not None else ""
    flush_field = " flush=1" if record.get("flush") else ""
    print(f"LAT mode={record['mode']} windowStart={window_started_at:.3f} sent={sent_at:.3f} "
          f"lagSec={whisper_seconds + window_seconds:.2f} whisperSec={whisper_seconds:.2f} "
          f"windowSec={window_seconds:.1f} videoTime={record['videoTime']:.2f} "
          f"source={record['source']} kind={record['kind']}{revision_field}{flush_field}", flush=True)


def is_reset_command(metadata: dict[str, Any] | None) -> bool:
    return metadata is not None and metadata.get("type") == "reset"


def is_source_switch(metadata: dict[str, Any] | None) -> bool:
    return metadata is not None and metadata.get("type") == "source-switch"


def resolve_window_size(is_first_chunk: bool) -> int:
    return CATCHUP_WINDOW_SIZE if is_first_chunk else WINDOW_SIZE


def compute_video_time(raw_video_time: float, word_time: float, is_first_chunk: bool) -> float:
    # Window anchor resolved by gateway; subtract retained overlap context (Issue 5.30).
    overlap_sec = 0.0 if is_first_chunk else OVERLAP_SIZE / SAMPLE_RATE
    return round(raw_video_time - overlap_sec + word_time, 2)


def bytes_to_float32(audio_bytes: bytes) -> np.ndarray:
    samples = array("h")
    samples.frombytes(audio_bytes)
    return np.asarray(samples, dtype=np.float32) / 32768.0


def parse_metadata(raw_message: str) -> dict[str, Any] | None:
    import json
    try:
        value = json.loads(raw_message)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def assign_caption_groups(words: list[dict[str, Any]], max_words: int) -> None:
    caption_start: float | None = None
    count = 0
    for word in words:
        if caption_start is None:
            caption_start = word["videoStart"]
        word["captionStart"] = caption_start
        count += 1
        if count >= max_words or word["w"].strip().endswith((".", "?", "!")):
            caption_start = None
            count = 0


def should_emit_words(words: list[dict[str, Any]], is_first_chunk: bool) -> bool:
    # First empty window signals detection; later empty windows skip UI rebuild (Issue 5.40).
    return bool(words) or is_first_chunk


def windowed_payload(result: DecodeResult, metadata: dict[str, Any] | None,
                     is_first_chunk: bool, scope: Scope) -> dict[str, Any] | None:
    raw_video_time = metadata.get("videoTimeAtCapture", 0.0) if metadata else 0.0
    words = [{"w": word["w"], "s": word["s"], "e": word["e"], "c": word["c"],
              "videoStart": compute_video_time(raw_video_time, word["s"], is_first_chunk),
              "videoEnd": compute_video_time(raw_video_time, word["e"], is_first_chunk),
              "sourceId": scope.sourceId} for word in result.words]
    assign_caption_groups(words, MAX_WORDS_PER_CAPTION)
    if not should_emit_words(words, is_first_chunk):
        return None
    return {"type": "words", **scope.wire(), "seq": metadata.get("seq") if metadata else None,
            "language": result.language, "languageProbability": result.language_probability,
            "voiced": result.voiced, "words": words}


async def transcribe_chunk(websocket: WebSocket, audio: np.ndarray,
                           metadata: dict[str, Any] | None, is_first_chunk: bool,
                           anchor_source_id: str | None = None) -> None:
    result = await runtime.decode(audio, None)
    scope = Scope.parse(metadata or {}, Scope(sourceId=anchor_source_id))
    payload = windowed_payload(result, metadata, is_first_chunk, scope)
    if payload is not None:
        await websocket.send_json(payload)
