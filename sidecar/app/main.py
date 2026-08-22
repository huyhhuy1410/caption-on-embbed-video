from fastapi import FastAPI, WebSocket

app = FastAPI(title="Caption AI Sidecar")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "caption-ai-sidecar"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    await websocket.send_json({"type": "status", "state": "listening"})
    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            if message.get("text") is not None:
                await websocket.send_json({"type": "ack", "message": message["text"]})
            elif message.get("bytes") is not None:
                await websocket.send_json({"type": "audio-received", "bytes": len(message["bytes"])})
    except Exception:
        return
