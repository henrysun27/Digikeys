// Tracks the audio clock -> performance.now() mapping: perf ms = ctx s * 1000 + offset.
// Every sample is a fresh pair (re-synced on each worklet message); the offset used is
// the median over the last smoothMs, so one late callback doesn't jitter onset times.
// Once per driftSampleMs the offset is logged, and the drift rate is the least-squares
// slope of that log over driftWindowS.
export type ClockParams = { smoothMs: number; driftSampleMs: number; driftWindowS: number };
export type ClockSource = "output timestamp" | "currentTime";
export type ClockStats = {
  source: ClockSource;
  offsetMs: number; // smoothed perf - ctx offset now
  sinceStartMs: number; // offset now minus the first one (since start or source change)
  driftMsPerMin: number | null; // null until the log spans a few samples
};

export class ClockSync {
  private recent: { t: number; offset: number }[] = [];
  private log: { t: number; offset: number }[] = [];
  private first: number | null = null;
  private source: ClockSource | null = null;
  private sourceSince = 0;
  private p: ClockParams;

  constructor(p: ClockParams) {
    this.p = p;
  }

  // Records a pair taken at perfNow. Returns true when a drift-log point was added.
  sample(offset: number, source: ClockSource, perfNow: number): boolean {
    if (source !== this.source) {
      // The two sources differ by up to the latency clamp; don't mix them.
      this.recent = [];
      this.log = [];
      this.first = null;
      this.source = source;
      this.sourceSince = perfNow;
    }
    this.recent.push({ t: perfNow, offset });
    while (this.recent.length > 1 && perfNow - this.recent[0].t > this.p.smoothMs) this.recent.shift();
    // Log only once the median spans a full window, so the start reference isn't one sample.
    if (perfNow - this.sourceSince < this.p.smoothMs) return false;
    const last = this.log.at(-1);
    if (last && perfNow - last.t < this.p.driftSampleMs) return false;
    const smoothed = this.offset();
    this.first ??= smoothed;
    this.log.push({ t: perfNow, offset: smoothed });
    while (this.log.length > 1 && perfNow - this.log[0].t > this.p.driftWindowS * 1000) this.log.shift();
    return true;
  }

  offset(): number {
    const v = this.recent.map((r) => r.offset).sort((a, b) => a - b);
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  toPerf(ctxTime: number): number {
    return ctxTime * 1000 + this.offset();
  }

  stats(): ClockStats {
    const offsetMs = this.offset();
    return {
      source: this.source!,
      offsetMs,
      sinceStartMs: offsetMs - (this.first ?? offsetMs),
      driftMsPerMin: this.log.length >= 5 ? slope(this.log) * 60_000 : null,
    };
  }
}

// Least-squares slope of offset over t, ms per ms.
function slope(pts: { t: number; offset: number }[]): number {
  const n = pts.length;
  const mt = pts.reduce((s, p) => s + p.t, 0) / n;
  const mo = pts.reduce((s, p) => s + p.offset, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.t - mt) * (p.offset - mo);
    den += (p.t - mt) ** 2;
  }
  return den > 0 ? num / den : 0;
}
