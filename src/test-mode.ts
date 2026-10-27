import { CONFIG } from "./config.ts";
import type { Layout, Zone } from "./layout.ts";

// extraNotes: zones that played during an attempt without being in its target.
export type TestScore = { taps: number; guessHits: number; checkHits: number; extraNotes: number };

// One zone, or two for a chord.
export type TestTarget = { zones: Zone[]; label: string };

// One go at a target: every tap from start until start + window counts toward it (window
// is chordWindowMs for a chord, so fingers landing slightly apart, with separate onsets,
// still make one chord; 0 for a single zone). played: zones the instant guesses played;
// checked: zones the stop-based checks found. line: the first tap's log line.
export type Attempt = {
  target: TestTarget;
  setting: string;
  start: number;
  window: number;
  played: Set<string>;
  checked: Set<string>;
  line: HTMLLIElement | null;
};

const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

// One random target at a time, a chord with chance CONFIG.test.chordChance. A target is a
// hit only if every one of its zones played (guess) or was found by the check. Scores
// cover the whole page session, across starts and stops, kept separately per setting and
// for single zones vs chords.
export class TestMode {
  active = false;
  target: TestTarget | null = null;
  readonly scores = new Map<string, TestScore>(); // setting -> score
  private attempt: Attempt | null = null;

  start(layout: Layout) {
    this.active = true;
    this.next(layout);
  }

  stop() {
    this.active = false;
    this.target = null;
    this.attempt = null;
  }

  isTarget(zone: Zone): boolean {
    return !!this.target?.zones.some((z) => z.id === zone.id);
  }

  // A new target, avoiding the current target's zones when the layout allows.
  next(layout: Layout) {
    const all = layout.zones;
    const fresh = all.filter((z) => !this.target?.zones.some((t) => t.id === z.id));
    const chord = all.length >= 2 && Math.random() < CONFIG.test.chordChance;
    const pool = fresh.length >= (chord ? 2 : 1) ? fresh : all;
    if (pool.length === 0) {
      this.target = null;
      return;
    }
    const first = pick(pool);
    const zones = chord ? [first, pick(pool.filter((z) => z !== first))] : [first];
    this.target = { zones, label: zones.map((z) => z.label).join(" + ") };
  }

  // The attempt an accepted tap at time t belongs to: the open chord attempt if t is in its
  // window, otherwise a new one for the current target (and the next target is shown).
  // opened says whether this tap started it; null if there is no target.
  join(t: number, setting: string, layout: Layout): { attempt: Attempt; opened: boolean } | null {
    const a = this.attempt;
    if (a && t >= a.start && t <= a.start + a.window) return { attempt: a, opened: false };
    if (!this.target) return null;
    const chord = this.target.zones.length > 1;
    this.attempt = {
      target: this.target,
      setting: chord ? `${setting} · chords` : setting,
      start: t,
      window: chord ? CONFIG.test.chordWindowMs : 0,
      played: new Set(),
      checked: new Set(),
      line: null,
    };
    this.next(layout);
    return { attempt: this.attempt, opened: true };
  }

  resetScores() {
    this.scores.clear();
  }

  // Scores a finished attempt.
  record(a: Attempt): { guess: boolean; check: boolean; extra: number } {
    const ids = a.target.zones.map((z) => z.id);
    const hit = {
      guess: ids.every((id) => a.played.has(id)),
      check: ids.every((id) => a.checked.has(id)),
      extra: [...a.played].filter((id) => !ids.includes(id)).length,
    };
    let score = this.scores.get(a.setting);
    if (!score) this.scores.set(a.setting, (score = { taps: 0, guessHits: 0, checkHits: 0, extraNotes: 0 }));
    score.taps++;
    if (hit.guess) score.guessHits++;
    if (hit.check) score.checkHits++;
    score.extraNotes += hit.extra;
    return hit;
  }
}
