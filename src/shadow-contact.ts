// Mic + shadow on the main thread: the guided calibration (light direction and contact
// threshold), and each finger's contacts from the per-frame gaps (shadow.ts).
import { CONFIG } from "./config.ts";
import type { Pt } from "./geometry.ts";
import { handOf } from "./taps.ts";

// A gap distribution: median and robust sigma (1.4826 MAD), units.
export type GapStats = { median: number; sigma: number; n: number };
// dir: unit direction in camera pixels (unmirrored) from a fingertip toward its shadow, the
// centre of the search sector. Gaps (units) under threshold are contact. rest, lift: the
// second round's distributions; dPrime: their separation.
export type ShadowFit = { dir: Pt; threshold: number; rest: GapStats; lift: GapStats; dPrime: number; fittedAt: number };

export const dirDegrees = (d: Pt) => (Math.atan2(d.y, d.x) * 180) / Math.PI;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function stats(xs: number[]): GapStats {
  const m = median(xs);
  return { median: m, sigma: Math.max(0.01, 1.4826 * median(xs.map((x) => Math.abs(x - m)))), n: xs.length };
}

type StepKind = "background" | "rest" | "lift";
const STEPS: { kind: StepKind; prompt: string }[] = [
  { kind: "background", prompt: "Take your hands off the desk" },
  { kind: "rest", prompt: "Rest both index fingers on the board" },
  { kind: "lift", prompt: "Lift both index fingers ~2 cm and hold" },
  { kind: "rest", prompt: "Rest both index fingers on the board again" },
  { kind: "lift", prompt: "Lift both index fingers ~2 cm again and hold" },
];

// One index fingertip in one frame: its gap and contrast as read, and the shadow tip
// relative to the fingertip in camera pixels over the unit (null with no shadow).
export type CalibrationSample = { gap: number | null; contrast: number; toShadow: Pt | null };
// One rest or lift step: accepted gaps (units), rejected frames by reason.
export type StepReport = { label: string; gaps: number[]; noShadow: number; weak: number };
export type CalibrationReport = { steps: StepReport[]; threshold: number | null };
export type CalibrationResult = { fit: ShadowFit | null; problem: string | null; report: CalibrationReport };

// Shown over the camera view while calibrating. progress: 0-1 through the measuring part of
// the step, null while the prompt settles (or, for the background, until hands are gone).
export type CalibrationPrompt = { step: number; steps: number; text: string; detail: string; progress: number | null };

// "Calibrate shadow", step by step (STEPS). Each step shows its prompt for settleMs, then
// measures for stepMs; the background step ends once a background is captured after the
// prompt settled (the sampler takes one from any frame with no hand). The first rest/lift
// round searches all around for the shadow; its lifted shadow direction (relative to the
// resting one) sets `dir`, which the second round searches around and the fit keeps.
export class ShadowCalibration {
  private step = 0;
  private stepStart: number | null = null;
  private lastT = 0;
  private handsInView = false;
  private vectors: Record<"rest" | "lift", Pt[]> = { rest: [], lift: [] };
  private steps: StepReport[] = STEPS.slice(1).map((s, i) => ({
    label: `${s.kind} ${i < 2 ? 1 : 2}`,
    gaps: [],
    noShadow: 0,
    weak: 0,
  }));
  dir: Pt | null = null;

  // Index fingertip samples of frame t (any number of hands), with the time of the latest
  // background capture. null while going; the result once done.
  add(t: number, readings: CalibrationSample[], backgroundT: number | null): CalibrationResult | null {
    const { settleMs, stepMs, minSamples } = CONFIG.shadow.calibration;
    this.stepStart ??= t;
    this.lastT = t;
    this.handsInView = readings.length > 0;
    const age = t - this.stepStart;
    const kind = STEPS[this.step].kind;
    if (kind === "background") {
      if (backgroundT === null || backgroundT < this.stepStart + settleMs) return null;
      return this.next(t);
    }
    if (age >= settleMs) {
      const s = this.steps[this.step - 1];
      for (const r of readings) {
        if (r.gap === null || !r.toShadow) s.noShadow++;
        else if (r.contrast < CONFIG.shadow.minShadowContrast) s.weak++;
        else {
          s.gaps.push(r.gap);
          if (this.step <= 2) this.vectors[kind].push(r.toShadow);
        }
      }
    }
    if (age < settleMs + stepMs) return null;
    if (this.step === 2) {
      // End of round 1: the light direction, or give up.
      const lift = this.vectors.lift;
      if (lift.length < minSamples) {
        return this.finish(`the lifted shadow was found in only ${lift.length} frames (need ${minSamples})`);
      }
      const med = (vs: Pt[]) => ({ x: median(vs.map((v) => v.x)), y: median(vs.map((v) => v.y)) });
      const l = med(lift);
      const r = this.vectors.rest.length ? med(this.vectors.rest) : { x: 0, y: 0 };
      const shift = Math.hypot(l.x - r.x, l.y - r.y) > 0.05 ? { x: l.x - r.x, y: l.y - r.y } : l;
      const len = Math.hypot(shift.x, shift.y);
      if (len === 0) return this.finish("no direction from the resting to the lifted shadow");
      this.dir = { x: shift.x / len, y: shift.y / len };
    }
    if (this.step === STEPS.length - 1) return this.fit();
    return this.next(t);
  }

  private next(t: number): null {
    this.step++;
    this.stepStart = t;
    return null;
  }

  private finish(problem: string | null, fit: ShadowFit | null = null, threshold: number | null = null): CalibrationResult {
    return { fit, problem, report: { steps: this.steps, threshold } };
  }

  // Round 2: d' and the threshold where both distributions are equally many sigmas away.
  private fit(): CalibrationResult {
    const { minSamples } = CONFIG.shadow.calibration;
    const [rest, lift] = [this.steps[2], this.steps[3]];
    const few = [rest, lift].filter((s) => s.gaps.length < minSamples);
    if (few.length) {
      return this.finish(few.map((s) => `${s.label} kept only ${s.gaps.length} frames (need ${minSamples})`).join("; "));
    }
    const r = stats(rest.gaps);
    const l = stats(lift.gaps);
    const dPrime = (l.median - r.median) / Math.sqrt((r.sigma ** 2 + l.sigma ** 2) / 2);
    const threshold = (r.median * l.sigma + l.median * r.sigma) / (r.sigma + l.sigma);
    const need = CONFIG.shadow.minShadowSeparation;
    if (!(dPrime >= need)) return this.finish(`separation d′ ${dPrime.toFixed(2)} is under ${need}`, null, threshold);
    const fit = { dir: this.dir!, threshold, rest: r, lift: l, dPrime, fittedAt: Date.now() };
    return this.finish(null, fit, threshold);
  }

  get prompt(): CalibrationPrompt {
    const { settleMs, stepMs } = CONFIG.shadow.calibration;
    const { kind, prompt } = STEPS[this.step];
    const age = this.stepStart === null ? 0 : this.lastT - this.stepStart;
    const base = { step: this.step + 1, steps: STEPS.length, text: prompt };
    if (kind === "background") {
      const detail = this.handsInView || age < settleMs ? "capturing the empty desk…" : "capturing…";
      return { ...base, detail: this.handsInView ? "hands still in view" : detail, progress: null };
    }
    if (age < settleMs) return { ...base, detail: "get ready…", progress: null };
    const s = this.steps[this.step - 1];
    const rejected = s.noShadow + s.weak ? `, ${s.noShadow + s.weak} rejected` : "";
    return { ...base, detail: `hold still · ${s.gaps.length} frames${rejected}`, progress: Math.min(1, (age - settleMs) / stepMs) };
  }
}

const isPt = (p: unknown): p is Pt =>
  typeof p === "object" && p !== null && Number.isFinite((p as Pt).x) && Number.isFinite((p as Pt).y);

export function loadShadowFit(): ShadowFit | null {
  try {
    const raw = localStorage.getItem(CONFIG.shadow.storageKey);
    if (!raw) return null;
    const f = JSON.parse(raw);
    const ok = isPt(f?.dir) && [f?.threshold, f?.dPrime, f?.fittedAt, f?.rest?.median, f?.lift?.median].every(Number.isFinite);
    return ok ? f : null;
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

// One finger's frame. gap: null with no shadow found, or one under minShadowContrast. tip:
// the filtered fingertip (cam coords); toShadow: cam-coord offset from it to the shadow tip.
export type FingerShadow = { finger: string; t: number; gap: number | null; contrast: number; tip: Pt; toShadow: Pt | null };
export type ShadowState = FingerShadow & { contact: boolean };
// From the first frame under the threshold to the first over threshold + hysteresis, with
// no shadow, or without the finger. at: the filtered fingertip on entry (cam coords). used:
// an onset played it (or played the finger as it came down onto it).
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
    for (const [finger, gaps] of this.gaps) if (!gaps.length || gaps[gaps.length - 1].t < t - keepMs) this.gaps.delete(finger);
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

  // The finger's contact still going on, if any.
  open(finger: string): Contact | null {
    const last = this.contacts.get(finger)?.at(-1);
    return last && last.end === null ? last : null;
  }

  // Its first contact overlapping from-to, if any.
  during(finger: string, from: number, to: number): Contact | null {
    return this.contacts.get(finger)?.find((c) => c.start <= to && (c.end === null || c.end >= from)) ?? null;
  }

  // Fingers with gaps in the last keepMs.
  measured(): string[] {
    return [...this.gaps.keys()];
  }

  // The latest gap and the largest within approachMs before it, both from frames with a
  // shadow; null if the latest frame has none.
  trend(finger: string): { gap: number; before: number | null } | null {
    const gaps = this.gaps.get(finger);
    const last = gaps?.at(-1);
    if (!gaps || !last || last.gap === null) return null;
    let before: number | null = null;
    for (const g of gaps) {
      if (g === last || g.gap === null || g.t < last.t - CONFIG.shadow.approachMs) continue;
      before = Math.max(before ?? -Infinity, g.gap);
    }
    return { gap: last.gap, before };
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
