// AudioWorklet chạy trên Audio Render Thread: trích xuất và downmix stereo thành mono
class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]) {
    const input = inputs[0];
    if (input.length === 0) return true;

    const left = input[0];
    const right = input[1];
    const mono = new Float32Array(left.length);

    // Gộp kênh trái/phải thành 1 kênh mono Float32 [-1.0, 1.0]
    for (let i = 0; i < left.length; i++) {
      mono[i] = right ? (left[i] + right[i]) / 2 : left[i];
    }

    // Gửi mảng mẫu sóng âm mono về cho capture.ts
    this.port.postMessage(mono);
    return true;
  }
}

registerProcessor("recorder-processor", RecorderProcessor);
