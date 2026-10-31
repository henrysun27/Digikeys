// The shadow on the main thread: the guided calibration (light direction and contact
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

  // Index fingertip samples of frame t (any number of hands), whether any hand was detected
  // (the background is only captured from frames without), and the time of the latest
  // background capture. null while going; the result once done.
  add(t: number, readings: CalibrationSample[], hands: boolean, backgroundT: number | null): CalibrationResult | null {
    const { settleMs, stepMs, minSamples } = CONFIG.shadow.calibration;
    this.lastT = t;
    this.handsInView = hands;
    const kind = STEPS[this.step].kind;
    // A rest or lift step starts once an index fingertip is in view.
    if (kind !== "background" && this.stepStart === null && readings.length === 0) return null;
    this.stepStart ??= t;
    const age = t - this.stepStart;
    if (kind === "background") {
      if (backgroundT === null || backgroundT < this.stepStart + settleMs) return null;
      return this.next();
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
    return this.next();
  }

  // Every step after the background is a rest or lift step, which starts on fingertips.
  private next(): null {
    this.step++;
    this.stepStart = null;
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
      return { ...base, detail: this.handsInView ? "hands still in view" : "capturing the empty desk…", progress: null };
    }
    if (this.stepStart === null) return { ...base, detail: "waiting for index fingertips in view…", progress: null };
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

// One finger's frame. gap: null with no shadow region found; contrast: the region's (see
// ShadowReading). tip: the filtered fingertip (cam coords); toShadow: cam-coord offset from
// it to the shadow tip.
export type FingerShadow = { finger: string; t: number; gap: number | null; contrast: number; tip: Pt; toShadow: Pt | null };
// contact: only with a shadow calibration (its threshold), else always false.
export type ShadowState = FingerShadow & { contact: boolean; confidence: number };
// From the first frame under the threshold to the first over threshold + hysteresis, with
// no shadow, or without the finger. at: the filtered fingertip on entry (cam coords).
export type Contact = { start: number; end: number | null; at: Pt };

// Shadow confidence 0-1 of one frame: none without a region, else its contrast mapped
// from CONFIG.shadow.confidence[0] to [1].
export function confidence(gap: number | null, contrast: number): number {
  const [lo, hi] = CONFIG.shadow.confidence;
  return gap === null ? 0 : Math.max(0, Math.min(1, (contrast - lo) / (hi - lo)));
}

type Frame = { t: number; gap: number | null; contrast: number; confidence: number };

export class ShadowContacts {
  private states = new Map<string, ShadowState>();
  private contacts = new Map<string, Contact[]>();
  private frames = new Map<string, Frame[]>();

  // Every finger measured in frame t; fingers measured before but not now lose contact.
  // threshold: the calibrated contact threshold, null without one (no contacts then). A
  // shadow under minShadowContrast never counts as contact.
  update(t: number, frame: FingerShadow[], threshold: number | null) {
    const { hysteresis, keepMs, minShadowContrast } = CONFIG.shadow;
    const seen = new Set<string>();
    for (const f of frame) {
      seen.add(f.finger);
      const was = this.states.get(f.finger)?.contact ?? false;
      const contact =
        threshold !== null &&
        f.gap !== null &&
        f.contrast >= minShadowContrast &&
        f.gap < threshold + (was ? hysteresis : 0);
      const c = confidence(f.gap, f.contrast);
      this.states.set(f.finger, { ...f, contact, confidence: c });
      if (contact !== was) this.mark(f.finger, t, contact ? f.tip : null);
      let frames = this.frames.get(f.finger);
      if (!frames) this.frames.set(f.finger, (frames = []));
      frames.push({ t, gap: f.gap, contrast: f.contrast, confidence: c });
      while (frames.length && frames[0].t < t - keepMs) frames.shift();
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
    for (const [finger, frames] of this.frames) {
      if (!frames.length || frames[frames.length - 1].t < t - keepMs) this.frames.delete(finger);
    }
  }

  // A contact starting at `at`, or (at null) the open one ending.
  private mark(finger: string, t: number, at: Pt | null) {
    let list = this.contacts.get(finger);
    if (!list) this.contacts.set(finger, (list = []));
    if (at) list.push({ start: t, end: null, at });
    else if (list.length && list[list.length - 1].end === null) list[list.length - 1].end = t;
  }

  // Forgets a hand's fingers, when its ID passes to a different hand.
  dropHand(hand: string) {
    for (const m of [this.states, this.contacts, this.frames]) {
      for (const finger of m.keys()) if (handOf(finger) === hand) m.delete(finger);
    }
  }

  clear() {
    this.states.clear();
    this.contacts.clear();
    this.frames.clear();
  }

  // The latest frame's fingers.
  current(): ShadowState[] {
    return [...this.states.values()];
  }

  // Its first contact overlapping from-to, if any.
  during(finger: string, from: number, to: number): Contact | null {
    return this.contacts.get(finger)?.find((c) => c.start <= to && (c.end === null || c.end >= from)) ?? null;
  }

  // Its frames from `from` to `to`, oldest first.
  between(finger: string, from: number, to: number): Frame[] {
    return (this.frames.get(finger) ?? []).filter((f) => f.t >= from && f.t <= to);
  }
}

// A finger's shadow vote on a strike (CONFIG.shadow.vote), veto-only: it can lower a score,
// never raise it. Judged on the finger's frames from `from` to `to` that lie within holdMs
// of the last of them: at the stop for the check, the latest frames for the guess. It
// penalizes only if every one of those frames with a shadow shows a gap clearly above the
// finger's own touching baseline (baseline + margin) and, when `steady`, the gap is no
// longer closing (it fell less than minShrink across them): a finger still coming down
// isn't judged hovering. factor: 1 - confidence × penalty then, else 1; confidence is the
// median over those frames (0 for frames without a shadow region). gap: the last gap seen.
export type ShadowVote = {
  finger: string;
  confidence: number;
  gap: number | null;
  baseline: number | null;
  factor: number;
  why: string;
};

export function shadowVote(
  contacts: ShadowContacts,
  baseline: number | null,
  finger: string,
  from: number,
  to: number,
  steady: boolean,
): ShadowVote {
  const { penalty, minShrink, margin, holdMs } = CONFIG.shadow.vote;
  const all = contacts.between(finger, from, to);
  const last = all.at(-1);
  const frames = last ? all.filter((f) => f.t >= last.t - holdMs) : [];
  const sure = frames.filter((f) => f.confidence > 0 && f.gap !== null);
  const gap = sure.at(-1)?.gap ?? null;
  const c = frames.length ? median(frames.map((f) => f.confidence)) : 0;
  const keep = (why: string): ShadowVote => ({ finger, confidence: c, gap, baseline, factor: 1, why });
  if (baseline === null) return keep("no touching baseline yet");
  if (c === 0 || gap === null) return keep("no clear shadow");
  const above = Math.min(...sure.map((f) => f.gap!)) - baseline;
  if (above < margin) return keep(`gap within ${margin} of baseline`);
  const closing = Math.max(...sure.map((f) => f.gap!)) - gap;
  if (steady && closing >= minShrink) return keep("gap still closing");
  return { finger, confidence: c, gap, baseline, factor: 1 - c * penalty, why: `gap stays ${above.toFixed(2)} above baseline` };
}

// A finger's touching baseline: the baselinePercentile of the gaps it showed at the stops of
// its accepted taps (the last baselineTaps of them), once there are minBaselineTaps.
export class TouchBaselines {
  private gaps = new Map<string, number[]>();

  add(finger: string, gap: number) {
    let xs = this.gaps.get(finger);
    if (!xs) this.gaps.set(finger, (xs = []));
    xs.push(gap);
    if (xs.length > CONFIG.shadow.vote.baselineTaps) xs.shift();
  }

  // null until there are enough taps.
  of(finger: string): number | null {
    const { minBaselineTaps, baselinePercentile } = CONFIG.shadow.vote;
    const xs = this.gaps.get(finger);
    if (!xs || xs.length < minBaselineTaps) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.round(baselinePercentile * (s.length - 1))];
  }

  count(finger: string): number {
    return this.gaps.get(finger)?.length ?? 0;
  }

  // Forgets a hand's fingers, when its ID passes to a different hand.
  dropHand(hand: string) {
    for (const finger of this.gaps.keys()) if (handOf(finger) === hand) this.gaps.delete(finger);
  }
}

// Test mode's hover judge for a played finger, over from-to: true if it hovered, false if
// it touched, null if the shadow can't tell (no frame with a shadow of minShadowContrast,
// the contrast contact needs). Calibrated: hovered unless it made contact. Uncalibrated:
// hovered if every such frame showed a clear gap.
export function hovered(contacts: ShadowContacts, fit: ShadowFit | null, finger: string, from: number, to: number): boolean | null {
  const sure = contacts
    .between(finger, from, to)
    .filter((f) => f.gap !== null && f.contrast >= CONFIG.shadow.minShadowContrast);
  if (sure.length === 0) return null;
  if (fit) return contacts.during(finger, from, to) === null;
  return sure.every((f) => f.gap! >= CONFIG.shadow.vote.minHoverGap);
}
