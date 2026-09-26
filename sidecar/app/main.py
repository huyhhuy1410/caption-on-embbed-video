from array import array
from contextlib import asynccontextmanager
from typing import Any

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from faster_whisper import WhisperModel

# === BƯỚC 1: Cấu hình hằng số cho Xử lý Bộ đệm Cửa sổ trượt (Sliding Window Buffering) ===
SAMPLE_RATE = 16000                     # Tần số lấy mẫu âm thanh: 16,000 Hz (16k mẫu/giây)
WINDOW_SIZE = 6 * SAMPLE_RATE          # Cửa sổ nhận diện 6 giây = 96,000 samples
OVERLAP_SIZE = int(1.5 * SAMPLE_RATE)    # Độ gối đầu (overlap) 1.5 giây = 24,000 samples
# Window "bắt kịp" cho lượt transcribe ĐẦU TIÊN sau reset/đầu stream (Issue 5.22).
#
# ⚠️ Video vẫn chạy realtime trong lúc ASR xử lý, nên nếu window đầu cũng đòi
# đủ 6s thì caption chỉ xuất hiện khi video đã đi qua ~6s — đúng cái khoảng
# trống thấy được ngay sau khi tua. Window nhỏ cho caption xuất hiện sớm hơn.
#
# ⚠️ Phải LỚN HƠN `OVERLAP_SIZE`: sau lượt này bộ đệm còn `[-OVERLAP_SIZE:]`
# và `compute_video_time` trừ đúng 1.5s cho nó. Nhỏ hơn thì phép trừ đó sai.
CATCHUP_WINDOW_SIZE = 3 * SAMPLE_RATE
MAX_BUFFER_SIZE = 12 * SAMPLE_RATE     # Giới hạn bộ đệm tối đa 12 giây (Watchdog chống tràn RAM)
MAX_WORDS_PER_CAPTION = 8

# Khai báo biến toàn cục lưu trữ mô hình Whisper AI
model: WhisperModel | None = None


# === BƯỚC 2: Quản lý Vòng đời Ứng dụng (FastAPI Lifespan) ===
@asynccontextmanager
async def lifespan(_: FastAPI):
    global model
    # Nạp mô hình Whisper AI "tiny" vào RAM khi Server vừa khởi động
    model = WhisperModel("tiny", device="cpu", compute_type="int8")
    yield
    # Giải phóng mô hình khi Server đóng
    model = None


app = FastAPI(title="Caption AI Sidecar", lifespan=lifespan)


# === BƯỚC 3: Endpoint Health Check ===
@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "caption-ai-sidecar"}


# === BƯỚC 4: Endpoint WebSocket Nhận Luồng Audio & Trả Phụ Đề Real-time ===
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    # 4.1. Bộ đệm âm thanh tích lũy các chunk từ Extension gửi sang
    audio_buffer = np.array([], dtype=np.float32)
    
    await websocket.accept()
    await websocket.send_json({"type": "status", "state": "listening"})
    
    pending_metadata: dict[str, Any] | None = None
    window_anchor: dict[str, Any] | None = None  # Anchor ghim metadata của Chunk 1 (đầu window)
    is_first_chunk = True
    try:
        while True:
            message = await websocket.receive()

            # 4.2. Xử lý Gói tin Text (Metadata JSON từ Extension)
            if message.get("text") is not None:
                pending_metadata = parse_metadata(message["text"])

                # Lệnh reset từ backend: user vừa tua (Issue 5.21).
                #
                # ⚠️ Bộ đệm đang giữ tới 6s tiếng của đoạn TRƯỚC khi tua, còn
                # `window_anchor` thì sắp bị ghim bằng mốc của đoạn SAU khi tua.
                # Để nguyên thì window kế tiếp là [tiếng cũ] + [tiếng mới] nhưng
                # bị dán mốc mới ⇒ phụ đề đúng ngay lúc tua rồi lệch ở đoạn ngay
                # sau, và tự khỏi sau đúng một chu kỳ.
                #
                # `is_first_chunk = True` vì bộ đệm rỗng nghĩa là window kế tiếp
                # bắt đầu ĐÚNG tại anchor, không còn 1.5s gối đầu để trừ đi.
                if is_reset_command(pending_metadata):
                    audio_buffer = np.array([], dtype=np.float32)
                    window_anchor = None
                    pending_metadata = None
                    is_first_chunk = True
                    print("Reset: dropped audio buffer after seek", flush=True)
                    continue

                # Ghim metadata của chunk đầu tiên làm Anchor cho Window 6s này
                if window_anchor is None:
                    window_anchor = pending_metadata
                continue

            # 4.3. Xử lý Gói tin Binary (Audio PCM Bytes)
            audio_bytes = message.get("bytes")
            if audio_bytes is None:
                continue

            if model is None:
                await websocket.send_json({"type": "error", "message": "Model is not loaded"})
                continue

            # 4.4. Đổi audio bytes nhị phân sang mảng Float32 và nối vào bộ đệm
            chunk_audio = bytes_to_float32(audio_bytes)
            audio_buffer = np.concatenate((audio_buffer, chunk_audio))
            
            # 4.5. Watchdog Protection: Nếu bộ đệm bị dồn quá 12s, cắt bỏ dữ liệu cũ bị trễ
            if len(audio_buffer) > MAX_BUFFER_SIZE:
                audio_buffer = audio_buffer[-OVERLAP_SIZE:]
                print("Watchdog: dropped stale audio", flush=True)

            # 4.6. Đủ audio cho một window -> Chạy Whisper AI
            #
            # ⚠️ Cỡ window KHÔNG cố định: lượt đầu sau reset dùng window nhỏ
            # để bắt kịp — xem `resolve_window_size` (Issue 5.22).
            window_size = resolve_window_size(is_first_chunk)
            if len(audio_buffer) >= window_size:
                window_audio = audio_buffer[:window_size]
                
                # Gọi hàm transcribe với window_anchor (Metadata của Chunk 1)
                await transcribe_chunk(websocket, window_audio, window_anchor, is_first_chunk)

                is_first_chunk = False
                # Giữ lại 1.5s cuối (24,000 samples) làm ngữ cảnh gối đầu cho window sau
                audio_buffer = audio_buffer[-OVERLAP_SIZE:]

                # Reset đinh ghim để chunk tiếp theo sẽ trở thành Anchor mới
                window_anchor = None

            pending_metadata = None
    except WebSocketDisconnect:
        return

# === Helper: Nhận diện lệnh reset từ backend (tách khỏi vòng lặp để test được) ===
def is_reset_command(metadata: dict[str, Any] | None) -> bool:
    """Backend gửi type="reset" khi user tua (Issue 5.21).

    Tách thành hàm thuần theo đúng bài học Issue 4.20: logic nằm trong vòng lặp
    `while` của websocket thì không test được, mà đây lại là nhánh quyết định
    phụ đề sau khi tua có khớp nội dung hay không.
    """
    return metadata is not None and metadata.get("type") == "reset"


# === Helper: Cỡ window cho lượt transcribe kế tiếp (tách khỏi vòng lặp để test được) ===
def resolve_window_size(is_first_chunk: bool) -> int:
    """Window nhỏ cho lượt ĐẦU sau reset/đầu stream, cỡ chuẩn cho các lượt sau.

    `is_first_chunk=True` nghĩa là bộ đệm bắt đầu ĐÚNG tại anchor (không có gì
    để trừ 1.5s) — đúng hai thời điểm user đang chờ caption xuất hiện: đầu
    stream, và ngay sau khi tua. Chờ đủ 6s ở đó tạo khoảng trống nhìn thấy được
    (Issue 5.22).

    Tách thành hàm thuần theo bài học Issue 4.20 — nhánh này nằm trong vòng lặp
    websocket thì không test được.
    """
    return CATCHUP_WINDOW_SIZE if is_first_chunk else WINDOW_SIZE


# === Helper: Hàm thuần tính mốc thời gian video cho một từ (tách khỏi whisper để test được) ===
def compute_video_time(raw_video_time: float, word_time: float, is_first_chunk: bool) -> float:
    base_video_time = raw_video_time - (1.5 if not is_first_chunk else 0.0)
    return round(base_video_time + word_time, 2)

# === BƯỚC 5: Helper Chuyển đổi Bytes PCM16 -> NumPy Float32 (-1.0 đến 1.0) ===
def bytes_to_float32(audio_bytes: bytes) -> np.ndarray:
    samples = array("h")  # "h" đại diện cho signed short 16-bit
    samples.frombytes(audio_bytes)
    return np.asarray(samples, dtype=np.float32) / 32768.0


# === BƯỚC 6: Helper Parse JSON Metadata ===
def parse_metadata(raw_message: str) -> dict[str, Any] | None:
    import json

    try:
        value = json.loads(raw_message)
    except json.JSONDecodeError:
        return None

    return value if isinstance(value, dict) else None


# === BƯỚC 7: Hàm Thực thi Whisper AI & Tính mốc thời gian Video chuẩn ===
async def transcribe_chunk(
    websocket: WebSocket,
    audio: np.ndarray,
    metadata: dict[str, Any] | None,
    is_first_chunk: bool,
) -> None:
    # 7.1. Chạy Whisper AI nhận dạng giọng nói kèm mốc thời gian từng từ
    segments, info = model.transcribe(
        audio,
        beam_size=1,
        word_timestamps=True,
        vad_filter=True,
    )

    # 7.2. Lấy mốc thời gian Video tại thời điểm bắt đầu Window (Anchor)
    raw_video_time = metadata.get("videoTimeAtCapture", 0.0) if metadata else 0.0
    words: list[dict[str, Any]] = []
    caption_start: float | None = None
    caption_word_count = 0

    for segment in segments:
        for word in segment.words or []:

            text = word.word.strip()

            # Video-clock key remains stable across overlap and replay.
            if caption_start is None:
                caption_start = compute_video_time(
                    raw_video_time,
                    word.start,
                    is_first_chunk,
                )

            words.append(
                {
                    "w": text,
                    "s": word.start,
                    "e": word.end,
                    "videoStart": compute_video_time(
                        raw_video_time,
                        word.start,
                        is_first_chunk,
                    ),
                    "videoEnd": compute_video_time(
                        raw_video_time,
                        word.end,
                        is_first_chunk,
                    ),
                    "captionStart": caption_start,
                    "c": word.probability,
                }
            )

            caption_word_count += 1

            # Bound each group so a long segment cannot cover the video.
            if (
                caption_word_count >= MAX_WORDS_PER_CAPTION
                or text.endswith((".", "?", "!"))
            ):
                caption_start = None
                caption_word_count = 0


    # 7.3. Trả về kết quả JSON chứa danh sách từ đã đồng bộ mốc thời gian Video
    await websocket.send_json(
        {
            "type": "words",
            "seq": metadata.get("seq") if metadata else None,
            "language": info.language,
            "languageProbability": info.language_probability,
            "words": words,
        }
    )

