from array import array
from contextlib import asynccontextmanager
from typing import Any

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from faster_whisper import WhisperModel

SAMPLE_RATE = 16000
WINDOW_SIZE = 6 * SAMPLE_RATE       # 96,000 samples (6 giây)
OVERLAP_SIZE = int(1.5 * SAMPLE_RATE) # 24,000 samples (1.5 giây)
MAX_BUFFER_SIZE = 12 * SAMPLE_RATE # max buffer size = 12 giây để tránh load quá nhiều audio vào memory
model: WhisperModel | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global model
    model = WhisperModel("tiny", device="cpu", compute_type="int8")
    yield
    model = None


app = FastAPI(title="Caption AI Sidecar", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "caption-ai-sidecar"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    audio_buffer = np.array([], dtype=np.float32)
    await websocket.accept()
    await websocket.send_json({"type": "status", "state": "listening"})
    pending_metadata: dict[str, Any] | None = None

    try:
        while True:
            message = await websocket.receive()
            if message.get("text") is not None:
                pending_metadata = parse_metadata(message["text"])
                continue

            audio_bytes = message.get("bytes")
            if audio_bytes is None:
                continue

            if model is None:
                await websocket.send_json({"type": "error", "message": "Model is not loaded"})
                continue

            # 1. Khi nhận được audio_bytes:
            chunk_audio = bytes_to_float32(audio_bytes)
            audio_buffer = np.concatenate((audio_buffer, chunk_audio))
            
            # Nếu buffer vượt quá max buffer size thì cắt bớt dữ liệu cũ để tránh memory overflow
            if len(audio_buffer) > MAX_BUFFER_SIZE:
                audio_buffer = audio_buffer[-OVERLAP_SIZE:]
                print("Watchdog: dropped stale audio", flush=True)

            # 2. Kiểm tra nếu bộ đệm đủ 6 giây (96,000 samples):
            if len(audio_buffer) >= WINDOW_SIZE:
                # Lấy đúng 6s đầu tiên để đưa vào Whisper
                window_audio = audio_buffer[:WINDOW_SIZE]
                await transcribe_chunk(websocket, window_audio, pending_metadata)
    
                # 3. Giữ lại 1.5s cuối (24,000 samples) làm ngữ cảnh cho window tiếp theo!
                audio_buffer = audio_buffer[-OVERLAP_SIZE:]

            pending_metadata = None
    except WebSocketDisconnect:
        return

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


async def transcribe_chunk(
    websocket: WebSocket,
    audio: np.ndarray,
    metadata: dict[str, Any] | None,
) -> None:

    segments, info = model.transcribe(
        audio,
        beam_size=1,
        word_timestamps=True,
        vad_filter=True,
    )

    words: list[dict[str, Any]] = []
    for segment in segments:
        for word in segment.words or []:
            words.append(
                {
                    "w": word.word.strip(),
                    "s": word.start,
                    "e": word.end,
                    "c": word.probability,
                }
            )

    await websocket.send_json(
        {
            "type": "words",
            "seq": metadata.get("seq") if metadata else None,
            "language": info.language,
            "languageProbability": info.language_probability,
            "words": words,
        }
    )
