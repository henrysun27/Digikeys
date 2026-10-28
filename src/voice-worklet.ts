// Audio-thread recorder for push-to-talk: copies the mic's first channel and posts it in
// batches. Any message stops it: the rest is flushed, then "done" is posted.
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

export type RecorderMessage = { type: "samples"; samples: Float32Array } | { type: "done" };

const BATCH = 4096;

class RecorderProcessor extends AudioWorkletProcessor {
  private buf = new Float32Array(BATCH);
  private n = 0;
  private stopped = false;

  constructor() {
    super();
    this.port.onmessage = () => {
      this.flush();
      this.stopped = true;
      this.port.postMessage({ type: "done" } satisfies RecorderMessage);
    };
  }

  private flush() {
    if (this.n === 0) return;
    const samples = this.buf.slice(0, this.n);
    this.port.postMessage({ type: "samples", samples } satisfies RecorderMessage, [samples.buffer]);
    this.n = 0;
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false;
    const ch = inputs[0]?.[0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === BATCH) this.flush();
      }
    }
    return true;
  }
}

registerProcessor("voice-recorder", RecorderProcessor);
