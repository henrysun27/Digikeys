// Live tuning of the One Euro filter (minCutoff, beta) and a jitter meter to tune it by.
import { CONFIG } from "./config.ts";
import type { Pt } from "./geometry.ts";

export type SmoothingParams = { minCutoff: number; beta: number };
export const SMOOTHING_DEFAULTS: SmoothingParams = { minCutoff: CONFIG.smoothing.minCutoff, beta: CONFIG.smoothing.beta };

// Every filter holds CONFIG.smoothing itself, so a change applies to all of them at once.
export function setSmoothing(p: SmoothingParams) {
  CONFIG.smoothing.minCutoff = p.minCutoff;
  CONFIG.smoothing.beta = p.beta;
}

// Saved values replace the CONFIG defaults; anything missing or out of slider range is ignored.
export function loadSmoothing() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG.smoothing.storageKey) ?? "null");
    const { sliders } = CONFIG.smoothing;
    const ok = (v: unknown, [min, max]: number[]) => typeof v === "number" && v >= min && v <= max;
    if (ok(saved?.minCutoff, sliders.minCutoff)) CONFIG.smoothing.minCutoff = saved.minCutoff;
    if (ok(saved?.beta, sliders.beta)) CONFIG.smoothing.beta = saved.beta;
  } catch {}
}

// null forgets the saved values.
export function saveSmoothing(p: SmoothingParams | null) {
  try {
    if (p) localStorage.setItem(CONFIG.smoothing.storageKey, JSON.stringify(p));
    else localStorage.removeItem(CONFIG.smoothing.storageKey);
  } catch {}
}

// Per fingertip ("A index"), how much the tip moved over the last jitterWindowMs: the RMS
// distance of its positions from their mean, in camera pixels, filtered (as drawn) and raw.
export type Jitter = { finger: string; filtered: number; raw: number; samples: number };

type JitterSample = { t: number; raw: Pt; filtered: Pt };

function rmsSpread(pts: Pt[]): number {
  const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return Math.sqrt(pts.reduce((s, p) => s + (p.x - mx) ** 2 + (p.y - my) ** 2, 0) / pts.length);
}

export class JitterMeter {
  private samples = new Map<string, JitterSample[]>();

  // raw and filtered in camera pixels; t in ms.
  add(finger: string, t: number, raw: Pt, filtered: Pt) {
    let list = this.samples.get(finger);
    if (!list) this.samples.set(finger, (list = []));
    list.push({ t, raw, filtered });
  }

  // Fingers seen within the window; fingers with fewer than 2 samples are skipped.
  read(now: number): Jitter[] {
    const out: Jitter[] = [];
    for (const [finger, list] of this.samples) {
      while (list.length && now - list[0].t > CONFIG.smoothing.jitterWindowMs) list.shift();
      if (list.length === 0) this.samples.delete(finger);
      if (list.length < 2) continue;
      out.push({
        finger,
        filtered: rmsSpread(list.map((s) => s.filtered)),
        raw: rmsSpread(list.map((s) => s.raw)),
        samples: list.length,
      });
    }
    return out;
  }
}
