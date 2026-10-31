// Per-frame step times for the debug panel's "Frame steps" row: each step's mean and max
// since the last report.
export type StepRow = { name: string; mean: number; max: number; n: number };

export class StepTimes {
  private steps = new Map<string, { sum: number; n: number; max: number }>();

  // Skips null (the detector has no such step).
  add(name: string, ms: number | null) {
    if (ms === null) return;
    let s = this.steps.get(name);
    if (!s) this.steps.set(name, (s = { sum: 0, n: 0, max: 0 }));
    s.sum += ms;
    s.n++;
    s.max = Math.max(s.max, ms);
  }

  // Every step since the last call, in the order first seen, and starts over.
  take(): StepRow[] {
    const rows = [...this.steps].map(([name, s]) => ({ name, mean: s.sum / s.n, max: s.max, n: s.n }));
    this.steps.clear();
    return rows;
  }
}
