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
  await audioContext.audioWorklet.addModule(
    chrome.runtime.getURL("dist/recorder-worklet.js"),
  );
  const worklet = new AudioWorkletNode(audioContext, "recorder-processor");
  let frameCount = 0;
  worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
    const float32 = event.data;
    const pcm16 = new Int16Array(float32.length);

    for (let i = 0; i < float32.length; i++) {
      const sample = Math.max(-1, Math.min(1, float32[i]));
      pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }

    frameCount++;

    if (frameCount % 50 === 0) {
      console.info('PCM16 frame:', frameCount, 'samples:', pcm16.length);
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
