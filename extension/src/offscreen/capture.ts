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
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);

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
