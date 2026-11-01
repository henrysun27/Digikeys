// Per-band level and rise for each audio block, for the session export. Diagnostic only:
// the onset decision (OnsetDetector) uses the broadband level. Each band is a 2nd-order
// bandpass (constant 0 dB peak gain) centred on the geometric mean of its edges; its rise
// is measured like OnsetDetector's: the block's band RMS over the RMS of the
// riseBaselineMs before the last riseWithinMs. Runs in the audio worklet, free of worklet
// globals.
import type { OnsetParams } from "./config.ts";

export type BandReading = { name: string; level: number; rise: number }; // rise linear, 0 while filling

class Bandpass {
  private b0: number;
  private b2: number;
  private a1: number;
  private a2: number;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(lo: number, hi: number, rate: number) {
    const top = Math.min(hi, rate * 0.45);
    const f0 = Math.sqrt(lo * top);
    const q = f0 / Math.max(1, top - lo);
    const w0 = (2 * Math.PI * f0) / rate;
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b2 = -alpha / a0;
    this.a1 = (-2 * Math.cos(w0)) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  // RMS of the filtered block.
  rms(x: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < x.length; i++) {
      const y = this.b0 * x[i] + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1;
      this.x1 = x[i];
      this.y2 = this.y1;
      this.y1 = y;
      sum += y * y;
    }
    return Math.sqrt(sum / x.length);
  }
}

export class BandRise {
  private readonly bands: { filter: Bandpass; recent: number[] }[];
  private readonly baseSize: number;
  private readonly keep: number;
  // The latest block's readings, updated in place (no allocation per block on the audio
  // thread); copy them to keep them.
  readonly last: BandReading[];

  constructor(p: OnsetParams, rate: number, blockMs: number) {
    this.baseSize = Math.max(1, Math.round(p.riseBaselineMs / blockMs));
    this.keep = this.baseSize + Math.max(1, Math.round(p.riseWithinMs / blockMs)) - 1;
    this.bands = p.bands.map((b) => ({ filter: new Bandpass(b.hz[0], b.hz[1], rate), recent: [] }));
    this.last = p.bands.map((b) => ({ name: b.name, level: 0, rise: 0 }));
  }

  // Every band's level and rise for this block, into last; the level joins the baseline
  // afterwards.
  push(block: Float32Array) {
    for (let k = 0; k < this.bands.length; k++) {
      const b = this.bands[k];
      const level = b.filter.rms(block);
      let rise = 0;
      if (b.recent.length === this.keep) {
        let power = 0;
        for (let i = 0; i < this.baseSize; i++) power += b.recent[i] * b.recent[i];
        const baseline = Math.sqrt(power / this.baseSize);
        rise = baseline > 0 ? level / baseline : Infinity;
      }
      b.recent.push(level);
      if (b.recent.length > this.keep) b.recent.shift();
      this.last[k].level = level;
      this.last[k].rise = rise;
    }
  }
}
