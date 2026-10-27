// One Euro filter (Casiez, Roussel & Vogel, CHI 2012): a low-pass filter whose cutoff rises
// with speed, so jitter is smoothed when the finger is still and lag stays small when it
// moves. Times in ms, cutoffs in Hz, beta per (unit/s) of speed.
export type OneEuroParams = { minCutoff: number; beta: number; dCutoff: number };

const alpha = (cutoff: number, dtSec: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dtSec));

export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private t = 0;
  private readonly p: OneEuroParams;

  constructor(p: OneEuroParams) {
    this.p = p;
  }

  filter(x: number, t: number): number {
    if (this.x === null) {
      this.x = x;
      this.t = t;
      return x;
    }
    const dt = (t - this.t) / 1000;
    if (dt <= 0) return this.x;
    this.t = t;
    this.dx += alpha(this.p.dCutoff, dt) * ((x - this.x) / dt - this.dx);
    this.x += alpha(this.p.minCutoff + this.p.beta * Math.abs(this.dx), dt) * (x - this.x);
    return this.x;
  }
}
