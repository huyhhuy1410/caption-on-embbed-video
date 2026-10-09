import type { CaptureScope } from "../shared/protocol";

let scope: CaptureScope = { sessionId: "", generation: 0, sourceId: null };
let videoTime = 0;
let clockReceivedAt = 0;
let playbackRate = 1;
let playing = false;
let sourceLanguage: string | null = null;
let socket: WebSocket | undefined;
let context: AudioContext | undefined;
let stream: MediaStream | undefined;
let source: MediaStreamAudioSourceNode | undefined;
let worklet: AudioWorkletNode | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelay = 250;
let pendingSamples: number[] = [];
let pendingStartEpochMs = 0;
let pendingStartVideoTime = 0;
let sequence = 0;
let captureToken = 0;
let active = false;

function currentVideoTime(): number {
  return videoTime + (playing ? (performance.now() - clockReceivedAt) / 1000 * playbackRate : 0);
}

function clearPartial(): void {
  pendingSamples = [];
  pendingStartEpochMs = 0;
  pendingStartVideoTime = 0;
}

function send(payload: object): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function relay(payload: object): void {
  void chrome.runtime.sendMessage({ ...payload, target: "service-worker" }).catch(() => {});
}

function announceScope(): void {
  relay({ type: "capture-scope", ...scope });
}

function bumpGeneration(): void {
  scope = { ...scope, generation: scope.generation + 1 };
  clearPartial();
  announceScope();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== "offscreen") return;
  if (message.type === "start-audio-capture") {
    void captureTabAudio(message.streamId).catch((error: unknown) => {
      relay({ type: "status", state: "error", message: String(error) });
      void stopTabAudio();
    });
  } else if (message.type === "stop-audio-capture") {
    void stopTabAudio();
  } else if (message.type === "video-clock") {
    if (!Number.isFinite(message.videoTime)) return;
    videoTime = message.videoTime;
    clockReceivedAt = performance.now();
    playbackRate = Number.isFinite(message.playbackRate) ? message.playbackRate : 1;
    if (typeof message.playing === "boolean") playing = message.playing;
    // Đang seek: video clock đứng yên, tab audio vẫn chạy. Dừng tích tụ frame
    // để không trộn audio của vị trí cũ và mới trong cùng một chuỗi.
    if (message.seeking === true) clearPartial();
  } else if (message.type === "source-switch") {
    const nextSource = typeof message.sourceId === "string" ? message.sourceId : null;
    if (nextSource !== scope.sourceId) sourceLanguage = null;
    scope = { ...scope, sourceId: nextSource };
    videoTime = Number.isFinite(message.videoTime) ? message.videoTime : 0;
    clockReceivedAt = performance.now();
    playing = message.playing === true;
    playbackRate = Number.isFinite(message.playbackRate) && message.playbackRate > 0 ? message.playbackRate : 1;
    bumpGeneration();
    send({ type: "source-switch", ...scope });
    send({ type: "source-language", ...scope, language: null });
  } else if (message.type === "seek") {
    if (!Number.isFinite(message.seekTimeAtCapture)) return;
    videoTime = message.seekTimeAtCapture;
    clockReceivedAt = performance.now();
    bumpGeneration();
    send({ type: "seek", ...scope, seekTimeAtCapture: videoTime });
  } else if (message.type === "source-language") {
    sourceLanguage = typeof message.language === "string" ? message.language : null;
    bumpGeneration();
    send({ type: "source-language", ...scope, language: sourceLanguage });
  } else if (message.type === "playback") {
    playing = message.state === "playing";
    if (Number.isFinite(message.videoTime)) videoTime = message.videoTime;
    clockReceivedAt = performance.now();
    clearPartial();
    send({ type: "playback", ...scope, state: message.state });
  } else if (message.type === "restore-snapshot") {
    if (message.sourceId !== scope.sourceId || message.sessionId !== scope.sessionId || message.generation !== scope.generation) return;
    send({ ...message, target: undefined, ...scope });
  }
});

function connectBackend(token: number): void {
  if (!active || token !== captureToken) return;
  const next = new WebSocket("ws://127.0.0.1:8000");
  socket = next;
  next.addEventListener("open", () => {
    if (socket !== next || token !== captureToken || !active) return next.close();
    reconnectDelay = 250;
    bumpGeneration();
    send({ type: "source-switch", ...scope });
    send({ type: "source-language", ...scope, language: sourceLanguage });
    send({ type: "seek", ...scope, seekTimeAtCapture: currentVideoTime() });
    relay({ type: "status", state: "connected" });
  });
  next.addEventListener("message", (event) => {
    if (socket !== next || token !== captureToken) return;
    try {
      const payload = JSON.parse(event.data);
      if (payload?.type === "sidecar-reconnected") {
        if (payload.sessionId !== scope.sessionId || payload.generation !== scope.generation || payload.sourceId !== scope.sourceId) return;
        bumpGeneration();
        send({ type: "source-switch", ...scope });
        send({ type: "source-language", ...scope, language: sourceLanguage });
        send({ type: "seek", ...scope, seekTimeAtCapture: currentVideoTime() });
      } else if (["words", "replay", "translation", "status", "error"].includes(payload?.type)) relay(payload);
    } catch {
      console.warn("Caption AI: invalid backend message");
    }
  });
  next.addEventListener("error", () => {
    relay({ type: "status", state: "disconnected" });
  });
  next.addEventListener("close", () => {
    if (socket !== next || token !== captureToken || !active) return;
    socket = undefined;
    clearPartial();
    relay({ type: "status", state: "disconnected" });
    reconnectTimer = setTimeout(() => connectBackend(token), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 5000);
  });
}

/**
 * Nhả mọi tài nguyên audio và đặt lại state NGAY (đồng bộ).
 *
 * Không được `await` gì trước khi gán lại global: một phiên mới có thể mở giữa
 * chừng, và teardown của phiên cũ sẽ xoá nhầm state của phiên mới. `context.close()`
 * là thao tác async duy nhất nên trả về cho caller await sau.
 */
function releaseAudio(): AudioContext | undefined {
  if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  const oldSocket = socket;
  const oldWorklet = worklet;
  const oldSource = source;
  const oldStream = stream;
  const oldContext = context;
  socket = undefined;
  worklet = undefined;
  source = undefined;
  stream = undefined;
  context = undefined;
  if (oldWorklet) {
    oldWorklet.port.onmessage = null;
    oldWorklet.disconnect();
  }
  oldSource?.disconnect();
  oldStream?.getTracks().forEach(track => track.stop());
  oldSocket?.close();
  clearPartial();
  playing = false;
  videoTime = 0;
  playbackRate = 1;
  sourceLanguage = null;
  scope = { sessionId: "", generation: 0, sourceId: null };
  return oldContext;
}

async function stopTabAudio(): Promise<void> {
  // Vô hiệu hoá callback của phiên đang chạy trước khi đụng tài nguyên.
  active = false;
  captureToken++;
  const oldContext = releaseAudio();
  await oldContext?.close().catch(() => {});
}

async function captureTabAudio(streamId: string): Promise<void> {
  // Token phải cấp trước mọi await, nếu không hai lần start chồng nhau cùng giữ
  // một token và cả hai đều đi tiếp với một `stream` chung.
  const token = ++captureToken;
  const oldContext = releaseAudio();
  await oldContext?.close().catch(() => {});
  const captured = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } } as MediaTrackConstraints,
    video: false,
  });
  if (token !== captureToken) {
    captured.getTracks().forEach(track => track.stop());
    return;
  }
  stream = captured;
  scope = { sessionId: crypto.randomUUID(), generation: 0, sourceId: null };
  sequence = 0;
  reconnectDelay = 250;
  active = true;
  const audio = new AudioContext({ sampleRate: 16000 });
  if (audio.sampleRate !== 16000) {
    await audio.close().catch(() => {});
    throw new Error("Capture requires 16 kHz audio");
  }
  context = audio;
  captured.getAudioTracks()[0]?.addEventListener("ended", () => {
    // Track cũ của phiên đã bị thay: dừng ở đây sẽ giết nhầm phiên mới.
    if (token !== captureToken) return;
    relay({ type: "status", state: "error", message: "Tab audio capture ended. Toggle captions to restart." });
    void stopTabAudio();
  });
  await audio.audioWorklet.addModule(chrome.runtime.getURL("dist/recorder-worklet.js"));
  if (token !== captureToken) {
    await audio.close().catch(() => {});
    return;
  }
  const recorder = new AudioWorkletNode(audio, "recorder-processor");
  worklet = recorder;
  recorder.port.onmessage = (event: MessageEvent<{ samples: Float32Array; contextTime: number }>) => {
    if (token !== captureToken || !playing || !scope.sourceId || socket?.readyState !== WebSocket.OPEN) {
      clearPartial();
      return;
    }
    const { samples, contextTime } = event.data;
    const now = performance.now();
    // Audio clock được map sang browser epoch; không dùng thời điểm gửi frame làm capture start.
    const blockStartEpochMs = performance.timeOrigin + now - (audio.currentTime - contextTime) * 1000;
    if (!pendingSamples.length) {
      pendingStartEpochMs = blockStartEpochMs;
      pendingStartVideoTime = currentVideoTime() - (audio.currentTime - contextTime) * playbackRate;
    }
    for (const sample of samples) {
      const value = Math.max(-1, Math.min(1, sample));
      pendingSamples.push(value < 0 ? value * 0x8000 : value * 0x7fff);
    }
    while (pendingSamples.length >= 16000) {
      const chunk = new Int16Array(pendingSamples.splice(0, 16000));
      sequence++;
      send({ type: "audio", ...scope, seq: sequence, frames: chunk.length, sampleRate: 16000,
        captureTime: now / 1000, capturedAtEpochMs: pendingStartEpochMs,
        frameStartVideoTime: pendingStartVideoTime,
        videoTimeAtCapture: pendingStartVideoTime + playbackRate,
        playbackRate });
      socket!.send(chunk.buffer);
      pendingStartEpochMs += 1000;
      pendingStartVideoTime += playbackRate;
    }
  };
  const input = audio.createMediaStreamSource(captured);
  source = input;
  input.connect(recorder);
  // Web Audio chỉ render node có đường đi tới destination; worklet không nối ra
  // thì `process()` không bao giờ chạy. Gain 0 giữ đồ thị sống mà không phát tiếng.
  const sink = audio.createGain();
  sink.gain.value = 0;
  recorder.connect(sink).connect(audio.destination);
  // tabCapture chặn route mặc định; giữ tiếng của tab qua audio graph riêng.
  input.connect(audio.destination);
  connectBackend(token);
  relay({ type: "capture-ready", ...scope });
}
