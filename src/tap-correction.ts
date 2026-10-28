import { CONFIG } from "./config.ts";
import type { Pt } from "./geometry.ts";
import { zoneAnchor, type Layout, type Zone } from "./layout.ts";

// Offset correction in board coords: corrected = raw + (dx, dy), the mean of (zone center
// aimed at - raw tap position) over calibration taps, fitted separately for guess and
// check positions since they come from different frames of the tap. Used only if it cuts
// the rms error by more than minImprovement; otherwise the taps are noise, not bias.
export type Correction = { dx: number; dy: number };
export type TapCorrections = { guess: Correction | null; check: Correction | null; fittedAt: number };
export type TapKind = "guess" | "check";
// correction null: too few taps, or too little improvement (why says which).
export type FitReport = {
  pairs: number;
  rmsBefore: number;
  rmsAfter: number;
  correction: Correction | null;
  why: string | null;
};
type Pair = { raw: Pt; target: Pt };

export function applyCorrection(c: Correction | null, p: Pt): Pt {
  return c ? { x: p.x + c.dx, y: p.y + c.dy } : p;
}

function rms(pairs: Pair[], c: Correction | null): number {
  const sq = pairs.map(({ raw, target }) => {
    const p = applyCorrection(c, raw);
    return (p.x - target.x) ** 2 + (p.y - target.y) ** 2;
  });
  return Math.sqrt(sq.reduce((a, b) => a + b, 0) / sq.length);
}

export function fitCorrection(pairs: Pair[]): FitReport {
  const { minPairs, minImprovement } = CONFIG.tapCalibration;
  const n = pairs.length;
  if (n < minPairs) return { pairs: n, rmsBefore: NaN, rmsAfter: NaN, correction: null, why: "too few taps" };
  const c: Correction = {
    dx: pairs.reduce((a, p) => a + p.target.x - p.raw.x, 0) / n,
    dy: pairs.reduce((a, p) => a + p.target.y - p.raw.y, 0) / n,
  };
  const rmsBefore = rms(pairs, null);
  const rmsAfter = rms(pairs, c);
  const ok = rmsAfter < rmsBefore * (1 - minImprovement);
  const why = ok ? null : `rms improved less than ${(minImprovement * 100).toFixed(0)}%`;
  return { pairs: n, rmsBefore, rmsAfter, correction: ok ? c : null, why };
}

const isCorrection = (c: unknown): c is Correction | null =>
  c === null ||
  (typeof c === "object" && Number.isFinite((c as Correction).dx) && Number.isFinite((c as Correction).dy));

export function loadCorrections(): TapCorrections | null {
  try {
    const raw = localStorage.getItem(CONFIG.tapCalibration.storageKey);
    if (!raw) return null;
    const c = JSON.parse(raw);
    return isCorrection(c?.guess) && isCorrection(c?.check) && Number.isFinite(c?.fittedAt) ? c : null;
  } catch {
    return null;
  }
}

export function saveCorrections(c: TapCorrections | null) {
  try {
    if (c) localStorage.setItem(CONFIG.tapCalibration.storageKey, JSON.stringify(c));
    else localStorage.removeItem(CONFIG.tapCalibration.storageKey);
  } catch {}
}

// Walks through the layout's zones, tapsPerZone taps each. Positions are recorded raw
// (uncorrected board coords): the guess at the onset, the check once it resolves.
export class TapCalibration {
  private readonly layout: Layout;
  private readonly zones: Zone[];
  private index = 0;
  private tapsOnZone = 0;
  private pending = 0; // taps whose check hasn't resolved yet
  private readonly pairs: Record<TapKind, Pair[]> = { guess: [], check: [] };

  constructor(layout: Layout) {
    this.layout = layout;
    this.zones = [...layout.zones];
  }

  // The zone to tap next, null once every zone has its taps.
  get zone(): Zone | null {
    return this.zones[this.index] ?? null;
  }

  get progress(): string {
    return `tap ${this.tapsOnZone + 1}/${CONFIG.tapCalibration.tapsPerZone}, zone ${this.index + 1}/${this.zones.length}`;
  }

  // An onset: returns the zone it was aimed at and moves on.
  take(): Zone | null {
    const zone = this.zone;
    if (!zone) return null;
    this.pending++;
    if (++this.tapsOnZone >= CONFIG.tapCalibration.tapsPerZone) {
      this.index++;
      this.tapsOnZone = 0;
    }
    return zone;
  }

  add(kind: TapKind, zone: Zone, raw: Pt | null) {
    // The target is where the crosshair is drawn: the middle of the zone's visible part.
    if (raw) this.pairs[kind].push({ raw, target: zoneAnchor(this.layout, zone) });
  }

  // The tap's check has resolved (with or without a position).
  settle() {
    this.pending--;
  }

  get finished(): boolean {
    return this.zone === null && this.pending === 0;
  }

  fit(): Record<TapKind, FitReport> {
    return { guess: fitCorrection(this.pairs.guess), check: fitCorrection(this.pairs.check) };
  }
}
