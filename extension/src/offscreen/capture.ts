// Mốc video.currentTime mới nhất, gửi từ content script qua service worker.
let videoTimeAtCapture = 0;

/**
 * Danh tính video đang phát — ghim vào MỖI chunk audio (Issue 5.20).
 *
 * ⚠️ Phải là biến sống theo phiên chứ không chỉ gửi lúc đổi video: backend dùng
 * nó để tách cache, mà cache nhận từ `words` về nhiều giây sau. Chunk audio
 * không mang danh tính thì sidecar không biết dán nguồn nào lên từ.
 */
let activeSourceId: string | null = null;

/**
 * Module scope để `stopTabAudio()` gọi được; nằm trong `captureTabAudio` thì
 * không có đường teardown, và tắt caption sẽ bỏ lại socket/AudioContext/track.
 */
let backendWebSocket: WebSocket | undefined;
let audioContext: AudioContext | undefined;
let capturedStream: MediaStream | undefined;
let audioSource: MediaStreamAudioSourceNode | undefined;
let rmsIntervalId: ReturnType<typeof setInterval> | undefined;

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "start-audio-capture") {
    void captureTabAudio(message.streamId);
  }
  if (message?.type === "stop-audio-capture") {
    void stopTabAudio();
  }
  // Mốc video.currentTime mới nhất từ content script.
  // Chỉ lưu mốc video mới nhất, không relay ngược lại.
  if (message?.type === "video-clock") {
    videoTimeAtCapture = message.videoTime;
  }
  if (message?.type === "source-switch") {
    const sourceId = String(message.sourceId ?? "");
    if (!sourceId) return;
    activeSourceId = sourceId;
    // Báo backend để nó đổi namespace cache và xoá bộ đệm bên sidecar.
    if (backendWebSocket?.readyState === WebSocket.OPEN) {
      backendWebSocket.send(JSON.stringify({ type: "source-switch", sourceId }));
      console.info("Caption AI offscreen: source switch sent", sourceId);
    } else {
      console.warn("Caption AI offscreen: backend socket is not open");
    }
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
  activeSourceId = null;
}

async function captureTabAudio(streamId: string) {
  // Bật lại khi phiên cũ chưa dọn (hiếm) ⇒ dọn trước, tránh hai socket cùng sống.
  await stopTabAudio();

  // Lấy luồng âm thanh của tab từ streamId.
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

  const context = new AudioContext({
    sampleRate: 16000,
  });
  audioContext = context;
  console.info("Sample rate:", context.sampleRate);

  // WebSocket tới backend (cổng 8000).
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

  // Kết quả trả về từ backend.
  socket.addEventListener("message", (event) => {
    console.info("Words from backend:", event.data);
    try {
      const parsed = JSON.parse(event.data);
      // ⚠️ Chuyển NGUYÊN message, không dựng lại object `{type, words}` như
      // trước — cách đó làm rơi mọi field khác mà backend gửi kèm (`translations`
      // ở replay chẳng hạn). Offscreen KHÔNG có `chrome.tabs` ⇒ gửi về SW, SW
      // biết tab nào (Issue 5.1).
      if (
        parsed.type === "words" ||
        parsed.type === "replay" ||
        parsed.type === "translation"
      ) {
        void chrome.runtime.sendMessage(parsed).catch((error: unknown) => {
          console.warn("Caption AI offscreen: could not relay message", error);
        });
      }
    } catch (error) {
      console.warn("Failed to parse message", error);
    }
  });

  await context.audioWorklet.addModule(
    chrome.runtime.getURL("dist/recorder-worklet.js"),
  );

  const worklet = new AudioWorkletNode(context, "recorder-processor");
  let pendingSamples: number[] = [];
  let chunkCount = 0;
  let sequence = 0;

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
              socket.send(
          JSON.stringify({
            type: "audio",
            seq: sequence,
            captureTime: performance.now() / 1000,
            sampleRate: context.sampleRate,
            videoTimeAtCapture: videoTimeAtCapture, // 👈 Đính kèm mốc thời gian video chuẩn
            // 👈 Danh tính video đang phát (Issue 5.20). `null` khi chưa biết —
            // sidecar chấp nhận, nhưng cache sẽ rơi vào namespace chung.
            sourceId: activeSourceId,
            frames: chunk.length,
          }),
        );

              socket.send(chunk.buffer);
        console.info("Sent PCM chunk:", chunkCount);
      }
    }
  };

  const source = context.createMediaStreamSource(stream);
  audioSource = source;
  source.connect(worklet);
  // Audio phải được route lại ra loa, nếu không user mất tiếng khi capture.
  source.connect(context.destination);

  // Đo RMS để phát hiện luồng thu âm câm.
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
