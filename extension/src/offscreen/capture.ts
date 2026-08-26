// Biến lưu mốc thời gian video.currentTime mới nhất được gửi từ Content script qua Service worker
let videoTimeAtCapture = 0;

// === BƯỚC 1: Lắng nghe tin nhắn từ Service Worker ===
chrome.runtime.onMessage.addListener((message) => {
  // 1.1. Lắng nghe lệnh khởi tạo thu âm Tab Audio từ Service Worker
  if (message?.type === "start-audio-capture") {
    void captureTabAudio(message.streamId);
  }
  // 1.2. Lắng nghe mốc thời gian video.currentTime cập nhật từ Content script
  if (message?.type === "video-clock") {
    videoTimeAtCapture = message.videoTime; // Lưu mốc thời gian video mới nhất
  }
});

// === BƯỚC 2: Hàm thực hiện Thu âm Tab và Truyền dữ liệu qua WebSocket ===
async function captureTabAudio(streamId: string) {
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

  // 2.2. Khởi tạo AudioContext với tần số lấy mẫu chuẩn 16,000 Hz
  const audioContext = new AudioContext({
    sampleRate: 16000,
  });
  console.info("Sample rate:", audioContext.sampleRate);

  // 2.3. Khởi tạo kết nối WebSocket tới Backend NestJS (Cổng 8000)
  const socket = new WebSocket("ws://127.0.0.1:8000");

  socket.addEventListener("open", () => {
    console.info("Connected to backend WebSocket");
  });

  // 2.4. Lắng nghe kết quả Subtitle trả về từ Backend NestJS
  socket.addEventListener("message", (event) => {
    console.info("Words from backend:", event.data);
  });

  // 2.5. Nạp module AudioWorklet xử lý PCM nhị phân
  await audioContext.audioWorklet.addModule(
    chrome.runtime.getURL("dist/recorder-worklet.js"),
  );

  const worklet = new AudioWorkletNode(audioContext, "recorder-processor");
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
            sampleRate: audioContext.sampleRate,
            videoTime: videoTimeAtCapture, // 👈 Đính kèm mốc thời gian video chuẩn
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
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(worklet);
  source.connect(audioContext.destination);

  // 2.10. Giám sát mức âm lượng (RMS) để kiểm tra luồng thu âm có âm thanh hay không
  const analyser = audioContext.createAnalyser();
  source.connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  setInterval(() => {
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
