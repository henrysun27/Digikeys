// Audio-thread onset detector. Per 128-sample block: RMS level, adaptive noise floor,
// sudden-rise check and refractory period. Posts onsets and periodic level reports.
import type { OnsetParams } from "./config.ts";

declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

// time: the block's audio-clock time, s. A level report's level is the peak since the
// previous report.
export type OnsetMessage =
  | { type: "onset"; time: number; level: number; threshold: number }
  | { type: "level"; time: number; level: number; floor: number; threshold: number };

const fromDb = (db: number) => 10 ** (db / 20);

class OnsetProcessor extends AudioWorkletProcessor {
  private p: OnsetParams;
  private thresholdRatio: number;
  private riseRatio: number;
  private minLevel: number;
  private floor = -1;
  private recent: number[] = [];
  private lastOnset = -Infinity;
  private reportPeak = 0;
  private lastReport = 0;

  constructor(options: { processorOptions: OnsetParams }) {
    super();
    this.p = options.processorOptions;
    this.thresholdRatio = fromDb(this.p.thresholdDb);
    this.riseRatio = fromDb(this.p.riseDb);
    this.minLevel = fromDb(this.p.minLevelDb);
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

    const threshold = Math.max(this.floor * this.thresholdRatio, this.minLevel);
    const before = this.recent.length ? this.recent.reduce((a, b) => a + b, 0) / this.recent.length : 0;
    const rising = level >= before * this.riseRatio;
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
        time: currentTime,
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
