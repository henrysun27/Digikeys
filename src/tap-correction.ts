import { CONFIG } from "./config.ts";
import type { Pt } from "./geometry.ts";
import { shapeCenter, type Layout, type Zone } from "./layout.ts";

// Per-axis correction in board coords: corrected = raw * scale + offset. Fitted by least
// squares from calibration taps (raw tap position vs the zone center aimed at), separately
// for guess and check positions, since they come from different frames of the tap.
export type AxisFit = { scale: number; offset: number };
export type Correction = { x: AxisFit; y: AxisFit; pairs: number; rmsBefore: number; rmsAfter: number };
export type TapCorrections = { guess: Correction | null; check: Correction | null; fittedAt: number };
export type TapKind = "guess" | "check";
type Pair = { raw: Pt; target: Pt };

export function applyCorrection(c: Correction | null, p: Pt): Pt {
  return c ? { x: p.x * c.x.scale + c.x.offset, y: p.y * c.y.scale + c.y.offset } : p;
}

// Falls back to offset only if the fitted scale is outside minScale..maxScale (too little
// spread in the taps to trust it).
function fitAxis(raw: number[], target: number[]): AxisFit {
  const { minScale, maxScale } = CONFIG.tapCalibration;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const mr = mean(raw);
  const mt = mean(target);
  let sxy = 0;
  let sxx = 0;
  raw.forEach((r, i) => {
    sxy += (r - mr) * (target[i] - mt);
    sxx += (r - mr) ** 2;
  });
  const scale = sxx > 1e-9 ? sxy / sxx : NaN;
  if (!(scale >= minScale && scale <= maxScale)) return { scale: 1, offset: mt - mr };
  return { scale, offset: mt - scale * mr };
}

function rms(pairs: Pair[], c: Correction | null): number {
  const sq = pairs.map(({ raw, target }) => {
    const p = applyCorrection(c, raw);
    return (p.x - target.x) ** 2 + (p.y - target.y) ** 2;
  });
  return Math.sqrt(sq.reduce((a, b) => a + b, 0) / sq.length);
}

// null if there are fewer than minPairs taps to fit.
export function fitCorrection(pairs: Pair[]): Correction | null {
  if (pairs.length < CONFIG.tapCalibration.minPairs) return null;
  const c: Correction = {
    x: fitAxis(pairs.map((p) => p.raw.x), pairs.map((p) => p.target.x)),
    y: fitAxis(pairs.map((p) => p.raw.y), pairs.map((p) => p.target.y)),
    pairs: pairs.length,
    rmsBefore: rms(pairs, null),
    rmsAfter: 0,
  };
  c.rmsAfter = rms(pairs, c);
  return c;
}

const isAxis = (a: unknown): a is AxisFit =>
  typeof a === "object" && a !== null && Number.isFinite((a as AxisFit).scale) && Number.isFinite((a as AxisFit).offset);
const isCorrection = (c: unknown): c is Correction | null =>
  c === null || (typeof c === "object" && isAxis((c as Correction).x) && isAxis((c as Correction).y));

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
  private readonly zones: Zone[];
  private index = 0;
  private tapsOnZone = 0;
  private pending = 0; // taps whose check hasn't resolved yet
  private readonly pairs: Record<TapKind, Pair[]> = { guess: [], check: [] };

  constructor(layout: Layout) {
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
    if (raw) this.pairs[kind].push({ raw, target: shapeCenter(zone.shape) });
  }

  // The tap's check has resolved (with or without a position).
  settle() {
    this.pending--;
  }

  get finished(): boolean {
    return this.zone === null && this.pending === 0;
  }

  fit(): TapCorrections {
    return { guess: fitCorrection(this.pairs.guess), check: fitCorrection(this.pairs.check), fittedAt: Date.now() };
  }
}
