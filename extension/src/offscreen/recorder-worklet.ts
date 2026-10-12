declare const currentTime: number;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][]): boolean;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input?.[0]) return true;
    const left = input[0];
    const right = input[1];
    const mono = new Float32Array(left.length);
    for (let i = 0; i < left.length; i++) {
      mono[i] = right ? (left[i] + right[i]) / 2 : left[i];
    }
    // Render-block timestamp keeps capture clock independent of MessagePort latency.
    this.port.postMessage({ samples: mono, contextTime: currentTime }, [mono.buffer]);
    return true;
  }
}

registerProcessor("recorder-processor", RecorderProcessor);
export {};
