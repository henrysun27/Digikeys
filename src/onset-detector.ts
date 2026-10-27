// Onset detection on per-block RMS levels. Runs in the audio worklet; kept free of
// worklet globals so it can be tested on recorded levels.
//
// floor: running median of the levels over floorWindowMs. A median sits at the typical
// background level, so a noise floor that wanders doesn't put the threshold inside the
// noise the way a minimum tracker does, and taps are too brief to move it.
// An onset needs the level to be at least thresholdDb over the floor, and to be a
// transient: at least minRiseDb over the RMS of the riseBaselineMs before the last
// riseWithinMs, i.e. a jump that happened within riseWithinMs.
import type { OnsetParams } from "./config.ts";

const fromDb = (db: number) => 10 ** (db / 20);

export type OnsetDecision = {
  onset: boolean;
  floor: number;
  threshold: number;
  rise: number; // level / baseline, linear (0 while the baseline is still filling)
};

export class OnsetDetector {
  private readonly p: OnsetParams;
  private readonly thresholdRatio: number;
  private readonly riseRatio: number;
  private readonly minLevel: number;
  private readonly floorSize: number; // blocks in the median window
  private readonly baseSize: number; // blocks in the rise baseline
  private readonly withinSize: number; // blocks the rise may take
  private readonly ring: number[] = []; // floor window, oldest first
  private readonly sorted: number[] = []; // the same levels, ascending
  private readonly recent: number[] = []; // last baseSize + withinSize - 1 levels, oldest first
  private lastOnset = -Infinity;

  constructor(p: OnsetParams, blockMs: number) {
    this.p = p;
    this.thresholdRatio = fromDb(p.thresholdDb);
    this.riseRatio = fromDb(p.minRiseDb);
    this.minLevel = fromDb(p.minLevelDb);
    this.floorSize = Math.max(1, Math.round(p.floorWindowMs / blockMs));
    this.baseSize = Math.max(1, Math.round(p.riseBaselineMs / blockMs));
    this.withinSize = Math.max(1, Math.round(p.riseWithinMs / blockMs));
  }

  get floor(): number {
    const n = this.sorted.length;
    if (n === 0) return 0;
    const m = n >> 1;
    return n % 2 ? this.sorted[m] : (this.sorted[m - 1] + this.sorted[m]) / 2;
  }

  // One block's level at time (s). The level joins the floor and baseline after the
  // decision, so a tap is compared with what came before it.
  push(level: number, time: number): OnsetDecision {
    const floor = this.floor;
    const threshold = Math.max(floor * this.thresholdRatio, this.minLevel);
    let rise = 0;
    if (this.recent.length === this.baseSize + this.withinSize - 1) {
      let power = 0;
      for (let i = 0; i < this.baseSize; i++) power += this.recent[i] * this.recent[i];
      const baseline = Math.sqrt(power / this.baseSize);
      rise = baseline > 0 ? level / baseline : Infinity;
    }
    const ready = (time - this.lastOnset) * 1000 >= this.p.mergeMs;
    const onset = this.sorted.length > 0 && level >= threshold && rise >= this.riseRatio && ready;
    if (onset) this.lastOnset = time;

    this.recent.push(level);
    if (this.recent.length > this.baseSize + this.withinSize - 1) this.recent.shift();
    this.ring.push(level);
    insertSorted(this.sorted, level);
    if (this.ring.length > this.floorSize) removeSorted(this.sorted, this.ring.shift()!);
    return { onset, floor, threshold, rise };
  }
}

// Index of the first element >= v.
function lowerBound(a: number[], v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function insertSorted(a: number[], v: number) {
  a.splice(lowerBound(a, v), 0, v);
}

function removeSorted(a: number[], v: number) {
  a.splice(lowerBound(a, v), 1);
}
