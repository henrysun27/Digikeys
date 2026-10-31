// Mic + shadow on the main thread: learning the shadow direction and contact threshold,
// and following each finger's contacts from the per-frame gaps (shadow.ts).
import { CONFIG } from "./config.ts";
import type { Pt } from "./geometry.ts";
import { candidateDirs } from "./shadow.ts";
import { handOf } from "./taps.ts";

// dir: unit direction in camera pixels (unmirrored) from a fingertip toward its shadow's
// tip. Gaps (finger units) under threshold are contact. touch, hover: median gaps along dir
// resting and lifted; margin: how far lifted gaps cleared resting ones (see
// CONFIG.shadow.calibration); seen: share of lifted frames with a shadow on the strip.
export type ShadowFit = {
  dir: Pt;
  threshold: number;
  touch: number;
  hover: number;
  margin: number;
  seen: number;
  samples: { rest: number; lift: number };
  fittedAt: number;
};

export const dirDegrees = (d: Pt) => (Math.atan2(d.y, d.x) * 180) / Math.PI;

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}

// The candidate direction where lifted gaps clear resting ones by the widest margin. A strip
// with no shadow counts as a gap the strip's full length (the shadow is beyond it); ties go
// to the direction that saw the lifted shadow more often.
function fitShadow(rest: (number | null)[][], lift: (number | null)[][]): ShadowFit | string {
  const { minSamples, percentile, minMargin } = CONFIG.shadow.calibration;
  if (rest.length < minSamples || lift.length < minSamples) {
    return `too few index fingertip frames (${rest.length} resting, ${lift.length} lifted, need ${minSamples} each)`;
  }
  const far = CONFIG.shadow.stripLength;
  const dirs = candidateDirs();
  let b: Omit<ShadowFit, "samples" | "fittedAt"> | null = null;
  for (let i = 0; i < dirs.length; i++) {
    const touch = rest.map((g) => g[i] ?? far);
    const hover = lift.map((g) => g[i] ?? far);
    const seen = lift.filter((g) => g[i] !== null).length / lift.length;
    const hi = quantile(touch, percentile);
    const lo = quantile(hover, 1 - percentile);
    const margin = lo - hi;
    if (!b || margin > b.margin || (margin === b.margin && seen > b.seen)) {
      b = { dir: dirs[i], threshold: (hi + lo) / 2, touch: quantile(touch, 0.5), hover: quantile(hover, 0.5), margin, seen };
    }
  }
  if (!b) return "no candidate directions";
  if (b.margin < minMargin) {
    return (
      `resting and lifted gaps overlap in every direction (best ${b.margin.toFixed(2)} at ` +
      `${dirDegrees(b.dir).toFixed(0)}°, need ${minMargin}): is there a clear shadow?`
    );
  }
  return { ...b, samples: { rest: rest.length, lift: lift.length }, fittedAt: Date.now() };
}

type Phase = "rest" | "lift";

// "Calibrate shadow": index fingers resting on the board, then lifted and held. Each phase
// waits settleMs, then collects collectMs of index fingertip readings in every candidate
// direction. Frame times drive it, from the first frame with an index fingertip.
export class ShadowCalibration {
  phase: Phase = "rest";
  private phaseStart: number | null = null;
  private gaps: Record<Phase, (number | null)[][]> = { rest: [], lift: [] };
  private lastT = 0;

  // null while collecting; once both phases are in, the fit or why it failed.
  add(t: number, gaps: (number | null)[][]): ShadowFit | string | null {
    const { settleMs, collectMs } = CONFIG.shadow.calibration;
    this.phaseStart ??= t;
    this.lastT = t;
    const age = t - this.phaseStart;
    if (age >= settleMs) this.gaps[this.phase].push(...gaps);
    if (age < settleMs + collectMs) return null;
    if (this.phase === "rest") {
      this.phase = "lift";
      this.phaseStart = t;
      return null;
    }
    return fitShadow(this.gaps.rest, this.gaps.lift);
  }

  get status(): string {
    const { settleMs, collectMs } = CONFIG.shadow.calibration;
    const what =
      this.phase === "rest"
        ? "rest both index fingertips on the board"
        : "lift both index fingertips about 2 cm off the board and hold them there";
    const age = this.phaseStart === null ? 0 : this.lastT - this.phaseStart;
    const step = this.phase === "rest" ? "1/2" : "2/2";
    const doing =
      this.phaseStart === null
        ? "waiting for index fingertips in view…"
        : age < settleMs
          ? "get ready…"
          : `hold still, measuring ${Math.min(100, ((age - settleMs) / collectMs) * 100).toFixed(0)}% ` +
            `(${this.gaps[this.phase].length} frames)`;
    return `Calibrating shadow ${step}: ${what}; ${doing}`;
  }
}

const isPt = (p: unknown): p is Pt =>
  typeof p === "object" && p !== null && Number.isFinite((p as Pt).x) && Number.isFinite((p as Pt).y);

export function loadShadowFit(): ShadowFit | null {
  try {
    const raw = localStorage.getItem(CONFIG.shadow.storageKey);
    if (!raw) return null;
    const f = JSON.parse(raw);
    return isPt(f?.dir) && Number.isFinite(f?.threshold) && Number.isFinite(f?.fittedAt) ? f : null;
  } catch {
    return null;
  }
}

export function saveShadowFit(f: ShadowFit) {
  try {
    localStorage.setItem(CONFIG.shadow.storageKey, JSON.stringify(f));
  } catch {
    // Storage full or blocked: the fit still holds for this session.
  }
}

// One finger's frame: gap along the fit's direction (null: no shadow on the strip). tip:
// the filtered fingertip (cam coords), toward: cam-coord offset of one finger unit along the
// shadow direction, for drawing the gap from the tip.
export type FingerShadow = { finger: string; t: number; gap: number | null; tip: Pt; toward: Pt };
export type ShadowState = FingerShadow & { contact: boolean };
// From the first frame under the threshold to the first over threshold + hysteresis, with
// no shadow, or without the finger. at: the filtered fingertip on entry (cam coords). used:
// an onset played it.
export type Contact = { start: number; end: number | null; at: Pt; used: boolean };

export class ShadowContacts {
  private states = new Map<string, ShadowState>();
  private contacts = new Map<string, Contact[]>();
  private gaps = new Map<string, { t: number; gap: number | null }[]>();

  // Every finger measured in frame t; fingers measured before but not now lose contact.
  update(t: number, frame: FingerShadow[], threshold: number) {
    const { hysteresis, keepMs } = CONFIG.shadow;
    const seen = new Set<string>();
    for (const f of frame) {
      seen.add(f.finger);
      const was = this.states.get(f.finger)?.contact ?? false;
      const contact = f.gap !== null && f.gap < threshold + (was ? hysteresis : 0);
      this.states.set(f.finger, { ...f, contact });
      if (contact !== was) this.mark(f.finger, t, contact ? f.tip : null);
      let gaps = this.gaps.get(f.finger);
      if (!gaps) this.gaps.set(f.finger, (gaps = []));
      gaps.push({ t, gap: f.gap });
      while (gaps.length && gaps[0].t < t - keepMs) gaps.shift();
    }
    for (const [finger, s] of this.states) {
      if (seen.has(finger)) continue;
      if (s.contact) this.mark(finger, t, null);
      this.states.delete(finger);
    }
    for (const [finger, list] of this.contacts) {
      while (list.length && list[0].end !== null && list[0].end < t - keepMs) list.shift();
      if (list.length === 0) this.contacts.delete(finger);
    }
  }

  // A contact starting at `at`, or (at null) the open one ending.
  private mark(finger: string, t: number, at: Pt | null) {
    let list = this.contacts.get(finger);
    if (!list) this.contacts.set(finger, (list = []));
    if (at) list.push({ start: t, end: null, at, used: false });
    else if (list.length && list[list.length - 1].end === null) list[list.length - 1].end = t;
  }

  // Forgets a hand's fingers, when its ID passes to a different hand.
  dropHand(hand: string) {
    for (const m of [this.states, this.contacts, this.gaps]) {
      for (const finger of m.keys()) if (handOf(finger) === hand) m.delete(finger);
    }
  }

  clear() {
    this.states.clear();
    this.contacts.clear();
    this.gaps.clear();
  }

  // The latest frame's fingers.
  current(): ShadowState[] {
    return [...this.states.values()];
  }

  all(): [string, Contact[]][] {
    return [...this.contacts];
  }

  // Fingers with gaps in the last keepMs.
  measured(): string[] {
    return [...this.gaps.keys()];
  }

  // A finger's smallest gap measured from `from` to `to`: undefined with no frames there,
  // null if none of them showed a shadow.
  minGap(finger: string, from: number, to: number): number | null | undefined {
    const xs = (this.gaps.get(finger) ?? []).filter((g) => g.t >= from && g.t <= to);
    if (xs.length === 0) return undefined;
    const found = xs.flatMap((g) => (g.gap === null ? [] : [g.gap]));
    return found.length ? Math.min(...found) : null;
  }
}
