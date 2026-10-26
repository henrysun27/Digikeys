// Audio-thread onset detector. Per 128-sample block: RMS level, adaptive noise floor,
// sudden-rise check and refractory period. Posts onsets and periodic level reports.
import type { OnsetParams } from "./config.ts";

declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

export type OnsetMessage =
  | { type: "onset"; time: number; level: number; threshold: number }
  | { type: "level"; level: number; floor: number; threshold: number };

class OnsetProcessor extends AudioWorkletProcessor {
  private p: OnsetParams;
  private floor = -1;
  private recent: number[] = [];
  private lastOnset = -Infinity;
  private reportPeak = 0;
  private lastReport = 0;

  constructor(options: { processorOptions: OnsetParams }) {
    super();
    this.p = options.processorOptions;
  }

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (!ch || ch.length === 0) return true;
    const p = this.p;
    const blockMs = (ch.length / sampleRate) * 1000;

    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    const level = Math.sqrt(sum / ch.length);
    if (this.floor < 0) this.floor = level;

    const threshold = Math.max(this.floor * p.thresholdRatio, p.minLevel);
    const before = this.recent.length ? this.recent.reduce((a, b) => a + b, 0) / this.recent.length : 0;
    const rising = level >= before * p.riseRatio;
    const ready = (currentTime - this.lastOnset) * 1000 >= p.refractoryMs;
    if (level >= threshold && rising && ready) {
      this.lastOnset = currentTime;
      this.port.postMessage({ type: "onset", time: currentTime, level, threshold } satisfies OnsetMessage);
    }

    // Floor falls quickly to the quiet level and rises slowly, so taps barely move it.
    const tau = level < this.floor ? p.floorFallMs : p.floorRiseMs;
    this.floor += (level - this.floor) * (1 - Math.exp(-blockMs / tau));

    this.recent.push(level);
    if (this.recent.length > Math.max(1, Math.round(p.riseLookbackMs / blockMs))) this.recent.shift();

    this.reportPeak = Math.max(this.reportPeak, level);
    if ((currentTime - this.lastReport) * 1000 >= p.reportMs) {
      this.port.postMessage({
        type: "level",
        level: this.reportPeak,
        floor: this.floor,
        threshold,
      } satisfies OnsetMessage);
      this.reportPeak = 0;
      this.lastReport = currentTime;
    }
    return true;
  }
}

registerProcessor("onset-detector", OnsetProcessor);
