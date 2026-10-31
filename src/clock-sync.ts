// Tracks the audio clock -> performance.now() mapping as a straight line: perf ms =
// ctx s × 1000 + offset(ctx), offset(ctx) = c0 + c1 × (ctx - ctx0), fitted to the
// (ctx, perf) pairs of the last fitWindowMs without the pairs whose residual exceeds
// outlierMad robust sigmas (1.4826 MAD, at least minOutlierMs), so a timestamp that jumps
// under load moves nothing. The slope c1 (the drift) is held at 0 until the pairs span
// minFitSpanS of audio time and clamped to ±maxDriftPpm, beyond any real crystal. The line
// is refitted at most every refitMs. Once per driftSampleMs the fitted offset is logged,
// and the long-term drift rate is the least-squares slope of that log over driftWindowS.
export type ClockParams = {
  fitWindowMs: number;
  refitMs: number;
  outlierMad: number;
  minOutlierMs: number;
  minFitSpanS: number;
  maxDriftPpm: number;
  driftSampleMs: number;
  driftWindowS: number;
};
export type ClockSource = "output timestamp" | "currentTime";
export type ClockStats = {
  source: ClockSource;
  offsetMs: number; // fitted perf - ctx offset at the latest pair
  sinceStartMs: number; // offset now minus the first logged one (since start or source change)
  driftMsPerMin: number | null; // from the drift log; null until it spans a few samples
  fitPpm: number; // the current fit's slope
  pairs: number; // in the fit window
  rejectedShare: number; // of those, rejected as outliers
  residualMs: number; // rms residual of the kept pairs
};

// t: performance.now() when the pair was taken, for the window. offset: perf - ctx × 1000.
type Pair = { t: number; ctx: number; offset: number };
type Line = { ctx0: number; c0: number; c1: number };

export class ClockSync {
  private pairs: Pair[] = [];
  private line: Line | null = null;
  private fittedAt = -Infinity;
  private fitInfo = { rejected: 0, residualMs: 0 };
  private log: { t: number; offset: number }[] = [];
  private first: number | null = null;
  private source: ClockSource | null = null;
  private sourceSince = 0;
  private p: ClockParams;

  constructor(p: ClockParams) {
    this.p = p;
  }

  // Records the pair (ctx s, perf ms), taken at perfNow. Returns true when a drift-log point
  // was added.
  sample(ctx: number, perf: number, source: ClockSource, perfNow: number): boolean {
    if (source !== this.source) {
      // The two sources differ by the output latency; don't mix them.
      this.pairs = [];
      this.log = [];
      this.first = null;
      this.source = source;
      this.sourceSince = perfNow;
    }
    this.pairs.push({ t: perfNow, ctx, offset: perf - ctx * 1000 });
    while (this.pairs.length > 1 && perfNow - this.pairs[0].t > this.p.fitWindowMs) this.pairs.shift();
    // The line moves slowly; refitting on every message would put ~0.2 ms before each onset.
    if (perfNow - this.fittedAt >= this.p.refitMs) {
      this.line = null;
      this.fittedAt = perfNow;
    }
    // Log only once the fit has a full window, so the start reference is a settled fit.
    if (perfNow - this.sourceSince < this.p.fitWindowMs) return false;
    const last = this.log.at(-1);
    if (last && perfNow - last.t < this.p.driftSampleMs) return false;
    const offset = this.offsetAt(ctx);
    this.first ??= offset;
    this.log.push({ t: perfNow, offset });
    while (this.log.length > 1 && perfNow - this.log[0].t > this.p.driftWindowS * 1000) this.log.shift();
    return true;
  }

  // Starts from the median offset with no slope (drift moves the offset well under a
  // millisecond over the window), which late pairs can't drag the way a least-squares line
  // is dragged; then twice: drop pairs past the outlier limit around the current line's
  // median residual and least-squares fit the rest.
  private fitted(): Line {
    if (this.line) return this.line;
    const all = this.pairs;
    let line: Line = { ctx0: 0, c0: median(all.map((q) => q.offset)), c1: 0 };
    let kept = all;
    for (let pass = 0; pass < 2; pass++) {
      const residuals = all.map((q) => q.offset - at(line, q.ctx));
      const center = median(residuals);
      const mad = median(residuals.map((r) => Math.abs(r - center)));
      const limit = Math.max(this.p.outlierMad * 1.4826 * mad, this.p.minOutlierMs);
      const next = all.filter((_, i) => Math.abs(residuals[i] - center) <= limit);
      if (next.length < 2) break;
      kept = next;
      line = fit(kept, this.p);
    }
    const sq = kept.map((q) => (q.offset - at(line, q.ctx)) ** 2);
    this.fitInfo = {
      rejected: all.length - kept.length,
      residualMs: sq.length ? Math.sqrt(sq.reduce((a, b) => a + b, 0) / sq.length) : 0,
    };
    return (this.line = line);
  }

  private offsetAt(ctx: number): number {
    return at(this.fitted(), ctx);
  }

  toPerf(ctxTime: number): number {
    return ctxTime * 1000 + this.offsetAt(ctxTime);
  }

  stats(): ClockStats {
    const latest = this.pairs.at(-1);
    const offsetMs = latest ? this.offsetAt(latest.ctx) : 0;
    const line = this.fitted();
    return {
      source: this.source!,
      offsetMs,
      sinceStartMs: offsetMs - (this.first ?? offsetMs),
      driftMsPerMin: this.log.length >= 5 ? slope(this.log) * 60_000 : null,
      fitPpm: line.c1 * 1000,
      pairs: this.pairs.length,
      rejectedShare: this.pairs.length ? this.fitInfo.rejected / this.pairs.length : 0,
      residualMs: this.fitInfo.residualMs,
    };
  }
}

const at = (l: Line, ctx: number) => l.c0 + l.c1 * (ctx - l.ctx0);

// Least-squares line of offset (ms) over ctx (s) through the pairs' centroid; slope in ms
// per s, 0 over a short span, clamped to ±maxDriftPpm.
function fit(ps: Pair[], p: ClockParams): Line {
  const n = ps.length;
  if (n === 0) return { ctx0: 0, c0: 0, c1: 0 };
  const ctx0 = ps.reduce((s, q) => s + q.ctx, 0) / n;
  const c0 = ps.reduce((s, q) => s + q.offset, 0) / n;
  let span = 0;
  let num = 0;
  let den = 0;
  for (const q of ps) {
    span = Math.max(span, Math.abs(q.ctx - ctx0));
    num += (q.ctx - ctx0) * (q.offset - c0);
    den += (q.ctx - ctx0) ** 2;
  }
  const max = p.maxDriftPpm / 1000;
  const c1 = 2 * span >= p.minFitSpanS && den > 0 ? Math.max(-max, Math.min(max, num / den)) : 0;
  return { ctx0, c0, c1 };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
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
