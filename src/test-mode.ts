import type { Layout, Zone } from "./layout.ts";

export type TestScore = { taps: number; guessHits: number; checkHits: number };

// One random target zone at a time. Each tap is scored against the target shown at its
// onset, twice: the instant guess (what played) and the stop-based check. Scores cover
// the whole page session, across starts and stops, kept separately per finger setting.
export class TestMode {
  active = false;
  target: Zone | null = null;
  readonly scores = new Map<string, TestScore>(); // finger setting -> score

  start(layout: Layout) {
    this.active = true;
    this.next(layout);
  }

  stop() {
    this.active = false;
    this.target = null;
  }

  // A random zone other than the current target.
  next(layout: Layout) {
    const pool = layout.zones.filter((z) => z.id !== this.target?.id);
    this.target = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  }

  record(
    setting: string,
    target: Zone,
    guessZone: Zone | null,
    checkZone: Zone | null,
  ): { guess: boolean; check: boolean } {
    const hit = { guess: guessZone?.id === target.id, check: checkZone?.id === target.id };
    let score = this.scores.get(setting);
    if (!score) this.scores.set(setting, (score = { taps: 0, guessHits: 0, checkHits: 0 }));
    score.taps++;
    if (hit.guess) score.guessHits++;
    if (hit.check) score.checkHits++;
    return hit;
  }
}
