// Shadow sampling for Mic + shadow: how far each fingertip is from its shadow's tip, read
// from the frame its landmarks came from. Runs where detection runs (the worker or the
// main thread), so it has no DOM dependencies.
import { CONFIG } from "./config.ts";
import type { Pt } from "./geometry.ts";
import type { HandFrame } from "./hand-detector.ts";

// tips: landmark indices to measure. dirs: unit directions in camera pixels (unmirrored)
// to measure along: the learned shadow direction, or while calibrating every candidate.
export type ShadowRequest = { tips: number[]; dirs: Pt[] };
// One fingertip of the detection's hand `hand` (its index in the HandFrame). scale: the
// finger unit in camera pixels. gaps: per requested direction, tip to shadow tip in finger
// units, null where the strip shows no shadow.
export type ShadowReading = { hand: number; tip: number; scale: number; gaps: (number | null)[] };
export type ShadowResult = { readings: ShadowReading[]; ms: number };

// Directions spread evenly around the circle, for calibration.
export function candidateDirs(): Pt[] {
  const n = CONFIG.shadow.directions;
  return Array.from({ length: n }, (_, i) => ({
    x: Math.cos((2 * Math.PI * i) / n),
    y: Math.sin((2 * Math.PI * i) / n),
  }));
}

// Grayscale of the frame region from (ox, oy), downscaled by kx, ky (grab pixels per frame
// pixel).
type Gray = { lum: Float32Array; w: number; h: number; ox: number; oy: number; kx: number; ky: number };

// Not willReadFrequently: a CPU canvas reads the whole GPU frame back to draw from it
// (3.8 ms median in headless Edge with the GPU), a GPU one only the small grab (0.6 ms).
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

function grab(src: CanvasImageSource, x0: number, y0: number, x1: number, y1: number): Gray {
  const k = CONFIG.shadow.downscale;
  const w = Math.max(1, Math.round((x1 - x0) * k));
  const h = Math.max(1, Math.round((y1 - y0) * k));
  canvas ??= new OffscreenCanvas(w, h);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  ctx ??= canvas.getContext("2d")!;
  ctx.drawImage(src, x0, y0, x1 - x0, y1 - y0, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < lum.length; i++) lum[i] = 0.299 * px[4 * i] + 0.587 * px[4 * i + 1] + 0.114 * px[4 * i + 2];
  return { lum, w, h, ox: x0, oy: y0, kx: w / (x1 - x0), ky: h / (y1 - y0) };
}

// Bilinear luminance at frame pixel (x, y); NaN outside the grab.
function lumAt(g: Gray, x: number, y: number): number {
  const u = (x - g.ox) * g.kx - 0.5;
  const v = (y - g.oy) * g.ky - 0.5;
  if (!(u >= 0 && v >= 0 && u <= g.w - 1 && v <= g.h - 1)) return NaN;
  const i = Math.floor(u);
  const j = Math.floor(v);
  const fu = u - i;
  const fv = v - j;
  const i1 = Math.min(i + 1, g.w - 1);
  const j1 = Math.min(j + 1, g.h - 1);
  const top = g.lum[j * g.w + i] * (1 - fu) + g.lum[j * g.w + i1] * fu;
  const bottom = g.lum[j1 * g.w + i] * (1 - fu) + g.lum[j1 * g.w + i1] * fu;
  return top * (1 - fv) + bottom * fv;
}

// The strip from tip along d: one value per cell, the mean across the strip's width. It
// ends where it leaves the grab.
function profile(g: Gray, tip: Pt, d: Pt, scale: number): number[] {
  const { stripLength, stripWidth, cell } = CONFIG.shadow;
  const step = cell * scale;
  const n = Math.round(stripLength / cell);
  const m = Math.max(1, Math.round(stripWidth / cell));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    let sum = 0;
    for (let j = 0; j < m; j++) {
      const across = (j - (m - 1) / 2) * step;
      const v = lumAt(g, tip.x + d.x * i * step - d.y * across, tip.y + d.y * i * step + d.x * across);
      if (Number.isNaN(v)) return out;
      sum += v;
    }
    out.push(sum / m);
  }
  return out;
}

// Tip to shadow tip along a strip profile, in finger units: where the dark run holding the
// darkest point (from skinSkip on) begins. Dark is under the level halfway between the
// darkest and brightest points (the desk) and also minContrast under the finger's own skin,
// so skin darker than the desk never passes for the shadow: a strip with only skin and
// desk on it has none. Walking back from the darkest point, not forward from the tip,
// skips skin and desk in between when the finger hovers; a touching finger's dark run
// reaches back to the finger's edge. null without a shadow: no point that dark, or a
// strip cut short by the frame's edge.
export function shadowGap(p: number[], skin: number): number | null {
  const { cell, skinSkip, minContrast } = CONFIG.shadow;
  const s = p.map((_, i) => (p[Math.max(0, i - 1)] + p[i] + p[Math.min(p.length - 1, i + 1)]) / 3);
  const k0 = Math.round(skinSkip / cell);
  if (s.length < k0 + 3) return null;
  let lo = k0;
  let hi = k0;
  for (let i = k0; i < s.length; i++) {
    if (s[i] < s[lo]) lo = i;
    if (s[i] > s[hi]) hi = i;
  }
  const dark = Math.min((s[hi] + s[lo]) / 2, skin * (1 - minContrast));
  if (s[hi] - s[lo] < minContrast * s[hi] || s[lo] >= dark) return null;
  let j = lo;
  while (j > k0 && s[j - 1] < dark) j--;
  const at = j > k0 ? j - 1 + (s[j - 1] - dark) / (s[j - 1] - s[j]) : k0;
  return at * cell;
}

// Mean luminance along the middle of the finger's last segment (tip to DIP, landmark
// tip - 1), which is skin whatever the light.
function skinAt(g: Gray, tip: Pt, dip: Pt): number {
  let sum = 0;
  let n = 0;
  for (const f of [0.3, 0.4, 0.5, 0.6, 0.7]) {
    const v = lumAt(g, tip.x + (dip.x - tip.x) * f, tip.y + (dip.y - tip.y) * f);
    if (Number.isNaN(v)) continue;
    sum += v;
    n++;
  }
  return n ? sum / n : NaN;
}

// Every requested fingertip of every hand, from one grab covering all their strips. The
// finger unit is the tip-to-PIP distance (landmark tip - 2) in camera pixels.
export function sampleShadows(src: CanvasImageSource, width: number, height: number, frame: HandFrame, req: ShadowRequest): ShadowResult {
  const start = performance.now();
  const { stripLength, stripWidth } = CONFIG.shadow;
  const px = (p: Pt) => ({ x: p.x * width, y: p.y * height });
  const tips = frame.landmarks.flatMap((hand, h) =>
    req.tips.map((tip) => {
      const at = px(hand[tip]);
      const base = px(hand[tip - 2]);
      return { hand: h, tip, at, dip: px(hand[tip - 1]), scale: Math.hypot(at.x - base.x, at.y - base.y) };
    }),
  );
  const reach = (t: (typeof tips)[number]) => (stripLength + stripWidth) * t.scale + 2;
  const x0 = Math.max(0, Math.floor(Math.min(...tips.map((t) => t.at.x - reach(t)))));
  const y0 = Math.max(0, Math.floor(Math.min(...tips.map((t) => t.at.y - reach(t)))));
  const x1 = Math.min(width, Math.ceil(Math.max(...tips.map((t) => t.at.x + reach(t)))));
  const y1 = Math.min(height, Math.ceil(Math.max(...tips.map((t) => t.at.y + reach(t)))));
  const g = tips.length && x1 - x0 >= 2 && y1 - y0 >= 2 ? grab(src, x0, y0, x1, y1) : null;
  const readings = tips.map(({ hand, tip, at, dip, scale }) => {
    const skin = g ? skinAt(g, at, dip) : NaN;
    const ok = g && scale > 0 && !Number.isNaN(skin);
    return { hand, tip, scale, gaps: req.dirs.map((d) => (ok ? shadowGap(profile(g, at, d, scale), skin) : null)) };
  });
  return { readings, ms: performance.now() - start };
}
