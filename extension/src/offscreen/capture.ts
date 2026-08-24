chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "start-audio-capture") return;
  void captureTabAudio(message.streamId);
});
async function captureTabAudio(streamId: string) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    } as MediaTrackConstraints,
    video: false,
  });
  const audioContext = new AudioContext({
    sampleRate: 16000,
  });
  console.info("Sample rate:", audioContext.sampleRate);
  const socket = new WebSocket("ws://127.0.0.1:8000");

  socket.addEventListener("open", () => {
    console.info("Connected to backend WebSocket");
  });
  await audioContext.audioWorklet.addModule(
    chrome.runtime.getURL("dist/recorder-worklet.js"),
  );

  const worklet = new AudioWorkletNode(audioContext, "recorder-processor");
  let pendingSamples: number[] = [];
  let chunkCount = 0;
  let sequence = 0;
  worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
    for (const sample of event.data) {
      const clamped = Math.max(-1, Math.min(1, sample));
      pendingSamples.push(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
    }
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
            sampleRate: audioContext.sampleRate,
            frames: chunk.length,
          }),
        );
      }
      console.info("PCM chunk:", chunkCount, "samples:", chunk.length);

      if (socket.readyState === WebSocket.OPEN) {
        socket.send(chunk.buffer);
        console.info("Sent PCM chunk:", chunkCount);
      }
    }
  };
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(worklet);
  source.connect(audioContext.destination);

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
