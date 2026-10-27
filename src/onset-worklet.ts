// Audio-thread onset detector: per 128-sample block, the RMS level goes through
// OnsetDetector (running-median floor, transient check, short merge window). Posts onsets
// and periodic level reports.
import type { OnsetParams } from "./config.ts";
import { OnsetDetector } from "./onset-detector.ts";

declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

// time: the block's audio-clock time, s. rise: the onset's level over the baseline before
// it, linear. A level report's level is the peak since the previous report.
export type OnsetMessage =
  | { type: "onset"; time: number; level: number; threshold: number; rise: number }
  | { type: "level"; time: number; level: number; floor: number; threshold: number };

class OnsetProcessor extends AudioWorkletProcessor {
  private p: OnsetParams;
  private detector: OnsetDetector | null = null;
  private reportPeak = 0;
  private lastReport = 0;

  constructor(options: { processorOptions: OnsetParams }) {
    super();
    this.p = options.processorOptions;
  }

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (!ch || ch.length === 0) return true;
    // Block size is fixed in practice; the detector's windows are set from the first one.
    this.detector ??= new OnsetDetector(this.p, (ch.length / sampleRate) * 1000);

    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    const level = Math.sqrt(sum / ch.length);
    const d = this.detector.push(level, currentTime);
    if (d.onset) {
      this.port.postMessage({
        type: "onset",
        time: currentTime,
        level,
        threshold: d.threshold,
        rise: d.rise,
      } satisfies OnsetMessage);
    }

    this.reportPeak = Math.max(this.reportPeak, level);
    if ((currentTime - this.lastReport) * 1000 >= this.p.reportMs) {
      this.port.postMessage({
        type: "level",
        time: currentTime,
        level: this.reportPeak,
        floor: d.floor,
        threshold: d.threshold,
      } satisfies OnsetMessage);
      this.reportPeak = 0;
      this.lastReport = currentTime;
    }
    return true;
  }
}

registerProcessor("onset-detector", OnsetProcessor);
