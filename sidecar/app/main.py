from array import array
from contextlib import asynccontextmanager
import time
from typing import Any

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from faster_whisper import WhisperModel

SAMPLE_RATE = 16000                     # Tần số lấy mẫu âm thanh: 16,000 Hz (16k mẫu/giây)

# Cửa sổ nhận diện: 3 giây (48,000 samples).
#
# Độ trễ = `WINDOW_SIZE` + thời gian chờ whisper. KHÔNG có số hạng `OVERLAP_SIZE`
# trong công thức: tăng overlap chỉ làm whisper gọi thường xuyên hơn, không làm
# chữ hiện sớm hơn. Muốn giảm độ trễ thì chỉ hạ `WINDOW_SIZE`.
#
# Nhịp xuất hiện không phải `WINDOW - OVERLAP` mà là bản làm tròn lên theo chunk
# 1 giây: `ceil((WINDOW - OVERLAP) / 1s) * 1s`.
#
# Các bất biến của `WINDOW_SIZE` do `test_window_size.py` chốt.
WINDOW_SIZE = 3 * SAMPLE_RATE

OVERLAP_SIZE = int(1.5 * SAMPLE_RATE)    # Độ gối đầu (overlap) 1.5 giây = 24,000 samples

# Window "bắt kịp" cho lượt transcribe ĐẦU TIÊN sau reset/đầu stream: video vẫn
# chạy trong lúc ASR xử lý, nên window đầu đòi đủ `WINDOW_SIZE` thì caption chỉ
# hiện sau khi video đã đi qua ngần đó.
#
# Phải lớn hơn `OVERLAP_SIZE`: sau lượt này bộ đệm còn `[-OVERLAP_SIZE:]` làm gối
# đầu, nên `compute_video_time` trừ đúng bằng độ dài đó. Bằng hoặc nhỏ hơn thì
# phần giữ lại chính là trọn window đã transcribe và phép trừ mất nghĩa.
CATCHUP_WINDOW_SIZE = 2 * SAMPLE_RATE

# ⚠️ Watchdog: phải lớn hơn `WINDOW_SIZE`, nếu không thì nó cắt bộ đệm đúng lúc
# window đang chờ đủ dữ liệu ⇒ transcribe lại cả đoạn, liên tục không ngừng.
MAX_BUFFER_SIZE = 12 * SAMPLE_RATE     # Giới hạn bộ đệm tối đa 12 giây (Watchdog chống tràn RAM)
# Số từ tối đa trong một nhóm caption trước khi buộc mở nhóm mới.
#
# Đây là TRẦN an toàn, không phải cách chia câu bình thường: `tiny` thường trả
# segment kết thúc bằng dấu câu nên nhánh `text.endswith` thắng hầu hết thời
# gian. Cắt theo số từ sẽ cắt giữa câu, nên trần phải rộng để câu dài có cơ hội
# đi tới dấu câu.
MAX_WORDS_PER_CAPTION = 16

model: WhisperModel | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global model
    # Nạp model một lần lúc khởi động.
    model = WhisperModel("tiny", device="cpu", compute_type="int8")
    yield
    model = None


app = FastAPI(title="Caption AI Sidecar", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "caption-ai-sidecar"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    # Bộ đệm âm thanh tích luỹ các chunk từ extension.
    audio_buffer = np.array([], dtype=np.float32)
    
    await websocket.accept()
    await websocket.send_json({"type": "status", "state": "listening"})
    
    pending_metadata: dict[str, Any] | None = None
    window_anchor: dict[str, Any] | None = None  # Anchor ghim metadata của Chunk 1 (đầu window)
    is_first_chunk = True

    # "Danh tính" nguồn phát đang chạy — xem `is_source_switch` (Issue 5.20).
    active_source: str | None = None
    try:
        while True:
            message = await websocket.receive()

            # Metadata JSON từ extension.
            if message.get("text") is not None:
                pending_metadata = parse_metadata(message["text"])

                # Lệnh reset từ backend: user vừa tua (Issue 5.21).
                #
                # Bộ đệm đang giữ audio của đoạn TRƯỚC khi tua, còn
                # `window_anchor` thì sắp bị ghim bằng mốc của đoạn SAU khi tua.
                # Để nguyên thì window kế tiếp là [tiếng cũ] + [tiếng mới] nhưng
                # bị dán mốc mới ⇒ phụ đề đúng ngay lúc tua rồi lệch ở đoạn ngay
                # sau, và tự khỏi sau đúng một chu kỳ.
                #
                # `is_first_chunk = True` vì bộ đệm rỗng nghĩa là window kế tiếp
                # bắt đầu ĐÚNG tại anchor, không còn gối đầu để trừ đi.
                if is_reset_command(pending_metadata):
                    audio_buffer = np.array([], dtype=np.float32)
                    window_anchor = None
                    pending_metadata = None
                    is_first_chunk = True
                    print("Reset: dropped audio buffer after seek", flush=True)
                    continue

                # Backend báo ĐỔI NGUỒN: activeVideo đổi sang video khác
                # (Issue 5.20 / FR-1.3). Giữ nguyên bộ đệm ở đây là lỗi: nó còn
                # audio của video CŨ, sẽ bị dán mốc thời gian của video MỚI
                # ⇒ nội dung video cũ hiện lên video mới, đúng triệu chứng đã gặp.
                #
                # Xoá y hệt nhánh reset vì đây cùng là "dữ liệu cũ sống sót qua
                # thời điểm chuyển nguồn" (gotcha #38). Khác ở chỗ: lần này ta
                # ghi lại danh tính nguồn mới để dán lên từng từ.
                if is_source_switch(pending_metadata):
                    # Đọc sourceId TRƯỚC khi xoá metadata, không thì mất.
                    active_source = str(pending_metadata.get("sourceId") or "") or None
                    audio_buffer = np.array([], dtype=np.float32)
                    window_anchor = None
                    pending_metadata = None
                    is_first_chunk = True
                    print(f"Source switch: {active_source}", flush=True)
                    continue

                # Tự chữa khi lệnh `source-switch` không tới được: mỗi chunk
                # audio đều mang `sourceId` của video đang phát, nên nhận ra
                # nguồn đổi ngay từ dữ liệu, không phụ thuộc lệnh đi qua.
                #
                # ⚠️ Không thay thế nhánh `source-switch` bên trên: lệnh đó tới
                # SỚM, xoá bộ đệm trước khi chunk audio mới kịp về — đợi tới đây
                # thì vài giây tiếng của video cũ vẫn còn nằm trong bộ đệm. Nhánh
                # này chỉ là lưới an toàn cho lúc backend socket đang đóng.
                chunk_source = str(pending_metadata.get("sourceId") or "") or None
                if chunk_source is not None and chunk_source != active_source:
                    print(
                        f"Source change seen in metadata: "
                        f"{active_source} -> {chunk_source}",
                        flush=True,
                    )
                    active_source = chunk_source
                    audio_buffer = np.array([], dtype=np.float32)
                    window_anchor = None
                    pending_metadata = None
                    is_first_chunk = True
                    continue

                # Ghim metadata của chunk đầu tiên làm Anchor cho window này
                if window_anchor is None:
                    window_anchor = pending_metadata
                continue

            # Audio PCM nhị phân.
            audio_bytes = message.get("bytes")
            if audio_bytes is None:
                continue

            if model is None:
                await websocket.send_json({"type": "error", "message": "Model is not loaded"})
                continue

            chunk_audio = bytes_to_float32(audio_bytes)
            audio_buffer = np.concatenate((audio_buffer, chunk_audio))
            
            # Watchdog: cắt dữ liệu cũ nếu bộ đệm dồn quá MAX_BUFFER_SIZE.
            if len(audio_buffer) > MAX_BUFFER_SIZE:
                audio_buffer = audio_buffer[-OVERLAP_SIZE:]
                print("Watchdog: dropped stale audio", flush=True)

            # Đủ audio cho một window thì chạy Whisper.
            #
            # ⚠️ Cỡ window KHÔNG cố định: lượt đầu sau reset dùng window nhỏ
            # để bắt kịp — xem `resolve_window_size` (Issue 5.22).
            window_size = resolve_window_size(is_first_chunk)
            if len(audio_buffer) >= window_size:
                window_audio = audio_buffer[:window_size]
                
                # Mốc thời gian thật để đo độ trễ — xem `log_latency`.
                window_started_at = time.perf_counter()

                # Gọi hàm transcribe với window_anchor (Metadata của Chunk 1).
                # `active_source` là nguồn TẠI THỜI ĐIỂM transcribe, còn anchor
                # mang nguồn của lúc window mở đầu — hai cái này bằng nhau vì
                # đổi nguồn đã xoá bộ đệm nên window không thể vắt qua mốc đó.
                await transcribe_chunk(
                    websocket,
                    window_audio,
                    window_anchor,
                    is_first_chunk,
                    active_source,
                )

                # Độ trễ = lúc này trừ lúc bắt đầu đợi + số giây audio đã gom mà
                # whisper vừa xử lý. Cộng `window_size` vì kể từ lúc frame đầu
                # tiên của window được gửi đi, video đã chạy được bấy nhiêu đó.
                log_latency(
                    window_anchor,
                    window_size,
                    time.perf_counter() - window_started_at,
                    is_first_chunk,
                    window_started_at,
                )

                is_first_chunk = False
                # Giữ lại 1.5s cuối (24,000 samples) làm ngữ cảnh gối đầu cho window sau
                audio_buffer = audio_buffer[-OVERLAP_SIZE:]

                # Reset đinh ghim để chunk tiếp theo sẽ trở thành Anchor mới
                window_anchor = None

            pending_metadata = None
    except WebSocketDisconnect:
        return

# === Helper: Ghi log độ trễ để đo thật ===
def log_latency(
    anchor: dict[str, Any] | None,
    window_size: int,
    whisper_seconds: float,
    is_first_chunk: bool,
    window_started_at: float,
) -> None:
    """In một dòng log đủ để TÍNH ĐỘ TRỄ thật, không chỉ log thời điểm.

    ⚠️ Vì sao cần: log backend KHÔNG có timestamp (gotcha #36), nên từ log đó
    không đo được độ trễ. Dòng này gộp ba mốc cần thiết, mỗi mốc một tên gọi
    riêng để grep/sort được.

    Ba mốc:
    - `audioStartAt` — giây monotonic lúc frame đầu tiên của window được gom.
    - `sentAt`       — giây monotonic lúc gửi `words` đi.
    - `lagSec`       — **độ trễ tính sẵn**, không cần tự trừ.

    ⚠️ `lagSec` = thời gian chờ whisper + độ dài audio đã gom. Lý do cộng độ
    dài audio: tính từ lúc window BẮT ĐẦU gom, video đã chạy được
    `window_size` giây rồi, mà trong `window_size` giây đó người dùng chưa
    thấy chữ nào. Nói cách khác đây là độ trễ so với thời điểm video bắt đầu
    phát đoạn audio đó — cái mà mắt người thật sự so.

    ⚠️ `videoTime` là mốc VIDEO của đoạn, khác `audioStartAt` (mốc máy). Hai
    cái này không trừ vào nhau được; giữ cả hai để khi đọc log mới biết đoạn
    nào ứng với video từ đâu.
    """
    sent_at = time.perf_counter()
    video_time = anchor.get("videoTimeAtCapture", 0.0) if anchor else 0.0
    window_seconds = window_size / SAMPLE_RATE
    lag = whisper_seconds + window_seconds
    kind = "catchup" if is_first_chunk else "steady"
    print(
        f"LAT windowStart={window_started_at:.3f} sent={sent_at:.3f} "
        f"lagSec={lag:.2f} whisperSec={whisper_seconds:.2f} "
        f"windowSec={window_seconds:.1f} videoTime={video_time:.2f} "
        f"source={anchor.get('sourceId') if anchor else None} kind={kind}",
        flush=True,
    )


# === Helper: Nhận diện lệnh reset từ backend (tách khỏi vòng lặp để test được) ===
def is_reset_command(metadata: dict[str, Any] | None) -> bool:
    """Backend gửi type="reset" khi user tua (Issue 5.21).

    Tách thành hàm thuần theo đúng bài học Issue 4.20: logic nằm trong vòng lặp
    `while` của websocket thì không test được, mà đây lại là nhánh quyết định
    phụ đề sau khi tua có khớp nội dung hay không.
    """
    return metadata is not None and metadata.get("type") == "reset"


# === Helper: Nhận diệu lệnh ĐỔI NGUỒN từ backend (tách khỏi vòng lặp để test được) ===
def is_source_switch(metadata: dict[str, Any] | None) -> bool:
    """Backend gõ type="source-switch" khi `activeVideo` đổi (Issue 5.20).

    Khác `is_reset_command` ở chỗ KÈM theo `sourceId` — đó là danh tính video
    mới, dán lên từng từ để backend tách cache theo nguồn (FR-1.3). Nhánh reset
    không đổi nguồn nên không cần.

    Tách thành hàm thuần theo đúng bài học Issue 4.20: logic nằm trong vòng lặp
    `while` của websocket thì không test được, mà đây là nhánh quyết định phụ đề
    sau khi đổi video có lẫn nội dung video trước hay không.
    """
    return metadata is not None and metadata.get("type") == "source-switch"


# === Helper: Cỡ window cho lượt transcribe kế tiếp (tách khỏi vòng lặp để test được) ===
def resolve_window_size(is_first_chunk: bool) -> int:
    """Window nhỏ cho lượt ĐẦU sau reset/đầu stream, cỡ chuẩn cho các lượt sau.

    `is_first_chunk=True` nghĩa là bộ đệm bắt đầu ĐÚNG tại anchor (không có gì
    để trừ 1.5s) — đúng hai thời điểm user đang chờ caption xuất hiện: đầu
    stream, và ngay sau khi tua. Chờ đủ window ở đó tạo khoảng trống nhìn thấy được
    (Issue 5.22).

    Tách thành hàm thuần theo bài học Issue 4.20 — nhánh này nằm trong vòng lặp
    websocket thì không test được.
    """
    return CATCHUP_WINDOW_SIZE if is_first_chunk else WINDOW_SIZE


# === Helper: Hàm thuần tính mốc thời gian video cho một từ (tách khỏi whisper để test được) ===
def compute_video_time(raw_video_time: float, word_time: float, is_first_chunk: bool) -> float:
    # ⚠️ Trừ ĐÚNG bằng `OVERLAP_SIZE`, KHÔNG hardcode 1.5 (Issue 5.30).
    #
    # Sau mỗi lượt, bộ đệm giữ lại `[-OVERLAP_SIZE:]` làm gối đầu cho window
    # sau, nên mốc phải lùi đúng bằng độ dài gối đó. Trước đây con số 1.5
    # viết cứng, **trùng với `OVERLAP_SIZE` do may mắn**: đổi `OVERLAP_SIZE`
    # thì mọi timestamp lệch, mà `test_window_size.py` vẫn xanh vì bất biến
    # "window > overlap" không hề nhìn vào chỗ trừ này.
    overlap_sec = 0.0 if is_first_chunk else OVERLAP_SIZE / SAMPLE_RATE
    return round(raw_video_time - overlap_sec + word_time, 2)

def bytes_to_float32(audio_bytes: bytes) -> np.ndarray:
    samples = array("h")  # "h" đại diện cho signed short 16-bit
    samples.frombytes(audio_bytes)
    return np.asarray(samples, dtype=np.float32) / 32768.0


def parse_metadata(raw_message: str) -> dict[str, Any] | None:
    import json

    try:
        value = json.loads(raw_message)
    except json.JSONDecodeError:
        return None

    return value if isinstance(value, dict) else None


# === Helper: Chia từ thành nhóm caption (tách khỏi vòng lặp để test được) ===
def assign_caption_groups(words: list[dict[str, Any]], max_words: int) -> None:
    """Gán `captionStart` cho từng từ, mỗi nhóm dùng chung một mốc.

    ⚠️ Tách thành hàm thuần theo bài học Issue 4.20: logic nằm trong hai vòng
    lặp lồng nhau của `transcribe_chunk` thì không test được, mà đây lại là
    nhánh quyết định chỗ nào bị cắt giữa câu.

    ⚠️ `captionStart` của một nhóm là video time của TỪ ĐẦU nhóm đó. Vì vậy nếu
    nhóm bị cắt giữa chừng (bởi `max_words` chứ không phải dấu câu) sẽ tách câu
    thành hai nhóm.

    ⚠️ Gán `captionStart` TRƯỚC khi kiểm tra điều kiện reset — từ cuối nhóm vẫn
    phải mang mốc của nhóm đó. Gán sau sẽ làm từ cuối nhận `None`.
    """
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


async def transcribe_chunk(
    websocket: WebSocket,
    audio: np.ndarray,
    metadata: dict[str, Any] | None,
    is_first_chunk: bool,
    anchor_source_id: str | None = None,
) -> None:
    # Nhận dạng kèm mốc thời gian từng từ.
    segments, info = model.transcribe(
        audio,
        beam_size=1,
        word_timestamps=True,
        vad_filter=True,
    )

    # Mốc video tại thời điểm bắt đầu window.
    raw_video_time = metadata.get("videoTimeAtCapture", 0.0) if metadata else 0.0
    # Danh tính nguồn của WINDOW này — dán lên từng từ để backend tách cache.
    # Lấy từ anchor của chính window, không phải metadata chunk cuối: window
    # kéo dài nhiều chunk nên source của các chunk sau có thể đã khác (Issue 5.20).
    source_id = str(anchor_source_id or "") or None
    words: list[dict[str, Any]] = []

    for segment in segments:
        for word in segment.words or []:

            text = word.word.strip()

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
                    "c": word.probability,
                    "sourceId": source_id,
                }
            )

    # Chia nhóm caption SAU khi dựng xong danh sách từ — hàm thuần, test được.
    assign_caption_groups(words, MAX_WORDS_PER_CAPTION)


    # Trả về danh sách từ đã đồng bộ mốc video.
    await websocket.send_json(
        {
            "type": "words",
            "seq": metadata.get("seq") if metadata else None,
            "language": info.language,
            "languageProbability": info.language_probability,
            "words": words,
        }
    )

