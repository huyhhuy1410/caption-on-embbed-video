from array import array
from contextlib import asynccontextmanager
from typing import Any

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from faster_whisper import WhisperModel


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

            await transcribe_chunk(websocket, audio_bytes, pending_metadata)
            pending_metadata = None
    except WebSocketDisconnect:
        return


def parse_metadata(raw_message: str) -> dict[str, Any] | None:
    import json

    try:
        value = json.loads(raw_message)
    except json.JSONDecodeError:
        return None

    return value if isinstance(value, dict) else None


async def transcribe_chunk(
    websocket: WebSocket,
    audio_bytes: bytes,
    metadata: dict[str, Any] | None,
) -> None:
    samples = array("h")
    samples.frombytes(audio_bytes)
    audio = np.asarray(samples, dtype=np.float32) / 32768.0

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
