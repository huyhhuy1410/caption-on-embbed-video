// Biến lưu mốc thời gian video.currentTime mới nhất được gửi từ Content script qua Service worker
let videoTimeAtCapture = 0;

/**
 * Tài nguyên của phiên capture, giữ ở module scope để còn TẮT được.
 *
 * ⚠️ Trước đây các biến này nằm trong `captureTabAudio` nên không có đường
 * teardown: tắt caption là socket, AudioContext, `setInterval` RMS và media
 * track đều sống tiếp cho tới khi reload extension.
 */
let backendWebSocket: WebSocket | undefined;
let audioContext: AudioContext | undefined;
let capturedStream: MediaStream | undefined;
let audioSource: MediaStreamAudioSourceNode | undefined;
let rmsIntervalId: ReturnType<typeof setInterval> | undefined;

// === BƯỚC 1: Lắng nghe tin nhắn từ Service Worker ===
chrome.runtime.onMessage.addListener((message) => {
  // 1.1. Lắng nghe lệnh khởi tạo thu âm Tab Audio từ Service Worker
  if (message?.type === "start-audio-capture") {
    void captureTabAudio(message.streamId);
  }
  // 1.2. Dọn sạch khi user tắt caption
  if (message?.type === "stop-audio-capture") {
    void stopTabAudio();
  }
  // 1.3. Lắng nghe mốc thời gian video.currentTime cập nhật từ Content script
  // Chỉ lưu mốc video mới nhất, không relay ngược lại.
  if (message?.type === "video-clock") {
    videoTimeAtCapture = message.videoTime;
  }
  if (message?.type === "seek") {
    console.info(
      "Caption AI offscreen: seek received, socket state:",
      backendWebSocket?.readyState,
    );
    if (backendWebSocket?.readyState === WebSocket.OPEN) {
      backendWebSocket.send(JSON.stringify(message));
      console.info("Caption AI offscreen: seek sent to backend");
    } else {
      console.warn("Caption AI offscreen: backend socket is not open");
    }
  }
});

/**
 * Dừng phiên capture và giải phóng mọi tài nguyên.
 *
 * Thứ tự: dừng bộ đếm trước (nó ghi log mỗi giây), rồi đóng socket, rồi ngắt
 * audio graph và transport. `chrome.offscreen.closeDocument()` KHÔNG được gọi —
 * SW giữ document sống để lần bật sau không phải chờ listener sẵn sàng
 * (Issue 2.3).
 */
async function stopTabAudio(): Promise<void> {
  console.info("Caption AI offscreen: stopping tab audio");

  if (rmsIntervalId !== undefined) {
    clearInterval(rmsIntervalId);
    rmsIntervalId = undefined;
  }

  backendWebSocket?.close();
  backendWebSocket = undefined;

  audioSource?.disconnect();
  audioSource = undefined;

  capturedStream?.getTracks().forEach((track) => track.stop());
  capturedStream = undefined;

  await audioContext?.close().catch((error: unknown) => {
    console.warn("Caption AI offscreen: audio context close failed", error);
  });
  audioContext = undefined;

  videoTimeAtCapture = 0;
}

// === BƯỚC 2: Hàm thực hiện Thu âm Tab và Truyền dữ liệu qua WebSocket ===
async function captureTabAudio(streamId: string) {
  // Bật lại khi phiên cũ chưa dọn (hiếm) ⇒ dọn trước, tránh hai socket cùng sống.
  await stopTabAudio();

  // 2.1. Lấy luồng âm thanh MediaStream của Tab trình duyệt từ streamId
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    } as MediaTrackConstraints,
    video: false,
  });
  capturedStream = stream;

  const audioTrack = stream.getAudioTracks()[0];
  audioTrack?.addEventListener("ended", () => {
    console.warn("Caption AI offscreen: tab audio track ended by browser/user");
  });

  // 2.2. Khởi tạo AudioContext với tần số lấy mẫu chuẩn 16,000 Hz
  const context = new AudioContext({
    sampleRate: 16000,
  });
  audioContext = context;
  console.info("Sample rate:", context.sampleRate);

  // 2.3. Khởi tạo kết nối WebSocket tới Backend NestJS (Cổng 8000)
  const socket = new WebSocket("ws://127.0.0.1:8000");
  backendWebSocket = socket;

  socket.addEventListener("open", () => {
    console.info("Connected to backend WebSocket");
  });

  socket.addEventListener("error", (event) => {
    console.error("Caption AI offscreen: backend WebSocket error", event);
  });

  socket.addEventListener("close", (event) => {
    console.warn(
      `Caption AI offscreen: backend WebSocket closed (code: ${event.code}, reason: ${event.reason || "none"})`,
    );
  });

  // 2.4. Lắng nghe kết quả Subtitle trả về từ Backend NestJS
  socket.addEventListener("message", (event) => {
    console.info("Words from backend:", event.data);
    try {
      const parsed = JSON.parse(event.data);
      // ⚠️ Chuyển NGUYÊN message, không dựng lại object `{type, words}` như
      // trước — cách đó làm rơi mọi field khác mà backend gửi kèm. Offscreen
      // KHÔNG có `chrome.tabs` ⇒ gửi về SW, SW biết tab nào (Issue 5.1).
      if (parsed.type === "words" || parsed.type === "replay") {
        void chrome.runtime.sendMessage(parsed).catch((error: unknown) => {
          console.warn("Caption AI offscreen: could not relay message", error);
        });
      }
    } catch (error) {
      console.warn("Failed to parse message", error);
    }
  });

  // 2.5. Nạp module AudioWorklet xử lý PCM nhị phân
  await context.audioWorklet.addModule(
    chrome.runtime.getURL("dist/recorder-worklet.js"),
  );

  const worklet = new AudioWorkletNode(context, "recorder-processor");
  let pendingSamples: number[] = [];
  let chunkCount = 0;
  let sequence = 0;

  // 2.6. Lắng nghe từng gói mẫu sóng âm Float32 từ AudioWorklet
  worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
    // Ép dải số thực [-1.0, 1.0] sang số nguyên PCM 16-bit
    for (const sample of event.data) {
      const clamped = Math.max(-1, Math.min(1, sample));
      pendingSamples.push(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
    }

    // Mỗi khi tích đủ 16,000 mẫu (tương đương 1 giây âm thanh)
    while (pendingSamples.length >= 16000) {
      const chunk = new Int16Array(pendingSamples.splice(0, 16000));
      chunkCount++;

      if (socket.readyState === WebSocket.OPEN) {
        sequence++;
        // 2.7. Gửi gói tin METADATA JSON trước
        socket.send(
          JSON.stringify({
            type: "audio",
            seq: sequence,
            captureTime: performance.now() / 1000,
            sampleRate: context.sampleRate,
            videoTimeAtCapture: videoTimeAtCapture, // 👈 Đính kèm mốc thời gian video chuẩn
            frames: chunk.length,
          }),
        );

        // 2.8. Gửi gói tin PCM AUDIO BINARY ngay sau đó
        socket.send(chunk.buffer);
        console.info("Sent PCM chunk:", chunkCount);
      }
    }
  };

  // 2.9. Nối luồng âm thanh từ Tab vào AudioWorklet và đầu ra Loa
  const source = context.createMediaStreamSource(stream);
  audioSource = source;
  source.connect(worklet);
  // Audio phải được route lại ra loa, nếu không user mất tiếng khi capture.
  source.connect(context.destination);

  // 2.10. Giám sát mức âm lượng (RMS) để kiểm tra luồng thu âm có âm thanh hay không
  const analyser = context.createAnalyser();
  source.connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  rmsIntervalId = setInterval(() => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const value of data) {
      const normalized = (value - 128) / 128;
      sum += normalized * normalized;
    }
    const rms = Math.sqrt(sum / data.length);
    console.info("Audio RMS:", rms);
  }, 1000);

  console.info("Tab audio capture started");
}
