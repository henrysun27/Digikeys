// Shadow sampling for Mic + motion + shadow: how far each fingertip is from its shadow,
// read from the frame its landmarks came from. Runs where detection runs (the worker or the
// main thread), so it has no DOM dependencies; its background estimate lives here too.
import { CONFIG } from "./config.ts";
import type { Pt } from "./geometry.ts";
import type { HandFrame } from "./hand-detector.ts";
import { HAND_CONNECTIONS } from "./hand-tracking.ts";

// tips: landmark indices to measure. dir: unit direction in camera pixels (unmirrored) from
// a fingertip toward its shadow, the shadow is searched within sectorDeg of it; null searches
// all around (calibration's first round). patches: also return each patch, for the check view.
export type ShadowRequest = { tips: number[]; dir: Pt | null; patches: boolean };
// A patch as sampled, patchCells square, the tip at its center, rows from the top of the
// camera frame (unmirrored). gray: luminance 0-255. kind per cell: see PatchKind. shadow:
// the shadow tip's cell, null if none.
export type PatchView = { gray: Uint8ClampedArray; kind: Uint8Array; shadow: Pt | null };
export const PatchKind = { desk: 0, hand: 1, shadow: 2, candidate: 3, outside: 4 } as const;
// One fingertip of detection `hand` (its index in the HandFrame). unit: the MCP-PIP length in
// camera pixels, which gaps are measured in. gap: fingertip to the nearest cell of its shadow,
// null with no shadow found. contrast: how much darker than the desk the shadow is (its
// mean darkening, 0-1), or with none found the darkest the search area got (90th percentile).
// shadow: the shadow tip, camera coords. background: whether the desk background was used.
export type ShadowReading = {
  hand: number;
  tip: number;
  unit: number;
  gap: number | null;
  contrast: number;
  shadow: Pt | null;
  background: boolean;
  patch?: PatchView;
};
// backgroundT: frame time of the latest background capture, null before the first.
export type ShadowResult = { readings: ShadowReading[]; ms: number; backgroundT: number | null };

// Grayscale of the frame region from (ox, oy), downscaled by kx, ky (grab pixels per frame
// pixel).
type Gray = { lum: Float32Array; w: number; h: number; ox: number; oy: number; kx: number; ky: number };

// Not willReadFrequently: a CPU canvas reads the whole GPU frame back to draw from it
// (3.8 ms median in headless Edge with the GPU), a GPU one only the small grab (0.6 ms).
type Grabber = { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D };
const grabbers: Record<"patch" | "background", Grabber | null> = { patch: null, background: null };

function grab(which: keyof typeof grabbers, src: CanvasImageSource, x0: number, y0: number, x1: number, y1: number): Gray {
  const k = CONFIG.shadow.downscale;
  const w = Math.max(1, Math.round((x1 - x0) * k));
  const h = Math.max(1, Math.round((y1 - y0) * k));
  let g = grabbers[which];
  if (!g) {
    const canvas = new OffscreenCanvas(w, h);
    g = grabbers[which] = { canvas, ctx: canvas.getContext("2d")! };
  }
  if (g.canvas.width !== w) g.canvas.width = w;
  if (g.canvas.height !== h) g.canvas.height = h;
  g.ctx.drawImage(src, x0, y0, x1 - x0, y1 - y0, 0, 0, w, h);
  const px = g.ctx.getImageData(0, 0, w, h).data;
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

// The desk with no hands on it: whole frames with no hand detected, blended in at most every
// background.intervalMs. bgT: the frame time of the latest.
let bg: Gray | null = null;
let bgT: number | null = null;

function updateBackground(src: CanvasImageSource, width: number, height: number, t: number) {
  const { intervalMs, blend } = CONFIG.shadow.background;
  if (bgT !== null && t - bgT < intervalMs) return;
  const next = grab("background", src, 0, 0, width, height);
  if (bg && bg.w === next.w && bg.h === next.h) {
    for (let i = 0; i < next.lum.length; i++) next.lum[i] = bg.lum[i] * (1 - blend) + next.lum[i] * blend;
  }
  bg = next;
  bgT = t;
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const f = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + f * dx), p.y - (a.y + f * dy));
}

function inPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// Every hand as bones (pixels within halfWidth of a skeleton segment) and a palm polygon,
// in camera pixels; halfWidth is handHalfWidth MCP-PIP units of that hand's index finger.
type HandShape = { bones: [Pt, Pt][]; palm: Pt[]; halfWidth: number };
const PALM = [0, 1, 5, 9, 13, 17];

function handShapes(frame: HandFrame, px: (p: Pt) => Pt): HandShape[] {
  return frame.landmarks.map((hand) => {
    const pts = hand.map(px);
    const unit = Math.hypot(pts[6].x - pts[5].x, pts[6].y - pts[5].y);
    return {
      bones: HAND_CONNECTIONS.map(([a, b]): [Pt, Pt] => [pts[a], pts[b]]),
      palm: PALM.map((i) => pts[i]),
      halfWidth: CONFIG.shadow.handHalfWidth * unit,
    };
  });
}

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}

// One fingertip's patch: patchCells square, patchRadius units each way from the tip.
//  1. Normalize: each cell's luminance over the background's there (the desk with no hand;
//     without one yet, the luminance alone), then over the desk level, the deskPercentile of
//     those ratios across the patch's cells off the hands, so exposure and light level
//     cancel. Darkening is 1 minus that: 0 for desk, 0.4 for a cell 40% darker than desk.
//  2. Mask the hands (their skin isn't shadow) and, given a direction, every cell more
//     than sectorDeg off it as seen from the tip.
//  3. Shadow candidates are cells at least minDarken dark; the shadow is the connected
//     region (4-neighbours, at least minArea cells) with the most darkness near the tip,
//     each cell's darkening weighted by exp(-distance to the tip / nearWeight units).
//  4. The gap runs from the tip to the region's nearest cell, in units.
function measure(
  g: Gray,
  hands: HandShape[],
  tip: Pt,
  unit: number,
  dir: Pt | null,
  withPatch: boolean,
): Omit<ShadowReading, "hand" | "tip"> {
  const { patchCells: n, patchRadius, sectorDeg, minDarken, deskPercentile, minArea, nearWeight } = CONFIG.shadow;
  const cell = (2 * patchRadius * unit) / n;
  const center = (i: number) => (i + 0.5 - n / 2) * cell;
  const near = hands.map((h) => ({
    ...h,
    bones: h.bones.filter(([a, b]) => distToSegment(tip, a, b) <= patchRadius * unit * Math.SQRT2 + h.halfWidth),
  }));
  const cosSector = Math.cos((sectorDeg * Math.PI) / 180);
  const kind = new Uint8Array(n * n);
  const ratio = new Float32Array(n * n).fill(NaN);
  const gray = new Uint8ClampedArray(n * n);
  const desk: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const p = { x: tip.x + center(i), y: tip.y + center(j) };
      const lum = lumAt(g, p.x, p.y);
      gray[k] = lum;
      const back = bg ? lumAt(bg, p.x, p.y) : 1;
      if (Number.isNaN(lum) || Number.isNaN(back)) {
        kind[k] = PatchKind.outside;
        continue;
      }
      if (near.some((h) => inPolygon(p, h.palm) || h.bones.some(([a, b]) => distToSegment(p, a, b) < h.halfWidth))) {
        kind[k] = PatchKind.hand;
        continue;
      }
      ratio[k] = lum / Math.max(back, 1);
      desk.push(ratio[k]);
      const r = Math.hypot(center(i), center(j));
      if (dir && r > 0 && (center(i) * dir.x + center(j) * dir.y) / r < cosSector) kind[k] = PatchKind.outside;
    }
  }
  const background = bg !== null;
  if (desk.length < minArea) return { unit, gap: null, contrast: 0, shadow: null, background };
  const level = quantile(desk, deskPercentile);
  const dark = new Float32Array(n * n);
  const searched: number[] = [];
  for (let k = 0; k < n * n; k++) {
    if (kind[k] !== PatchKind.desk) continue;
    dark[k] = 1 - ratio[k] / level;
    searched.push(dark[k]);
    if (dark[k] >= minDarken) kind[k] = PatchKind.candidate;
  }

  // Connected candidate regions; keep the one with the most darkness near the tip.
  const seen = new Uint8Array(n * n);
  let best: { cells: number[]; score: number; nearest: number; at: number } | null = null;
  for (let k0 = 0; k0 < n * n; k0++) {
    if (kind[k0] !== PatchKind.candidate || seen[k0]) continue;
    const cells: number[] = [];
    const queue = [k0];
    seen[k0] = 1;
    while (queue.length) {
      const k = queue.pop()!;
      cells.push(k);
      const i = k % n;
      const j = (k - i) / n;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = i + di;
        const b = j + dj;
        const m = b * n + a;
        if (a >= 0 && b >= 0 && a < n && b < n && !seen[m] && kind[m] === PatchKind.candidate) {
          seen[m] = 1;
          queue.push(m);
        }
      }
    }
    if (cells.length < minArea) continue;
    let score = 0;
    let nearest = Infinity;
    let at = cells[0];
    for (const k of cells) {
      const i = k % n;
      const r = Math.hypot(center(i), center((k - i) / n));
      score += dark[k] * Math.exp(-r / (nearWeight * unit));
      if (r < nearest) [nearest, at] = [r, k];
    }
    if (!best || score > best.score) best = { cells, score, nearest, at };
  }

  let shadowCell: Pt | null = null;
  let result: Omit<ShadowReading, "hand" | "tip">;
  if (best) {
    for (const k of best.cells) kind[k] = PatchKind.shadow;
    const i = best.at % n;
    const j = (best.at - i) / n;
    shadowCell = { x: i + 0.5, y: j + 0.5 };
    const contrast = best.cells.reduce((s, k) => s + dark[k], 0) / best.cells.length;
    const shadow = { x: tip.x + center(i), y: tip.y + center(j) };
    result = { unit, gap: best.nearest / unit, contrast, shadow, background };
  } else {
    const contrast = searched.length ? Math.max(0, quantile(searched, 0.9)) : 0;
    result = { unit, gap: null, contrast, shadow: null, background };
  }
  if (withPatch) result.patch = { gray, kind, shadow: shadowCell };
  return result;
}

// Every requested fingertip of every hand, from one grab covering all their patches; with no
// hand in the frame, the background is updated instead. t: the frame's time.
export function sampleShadows(
  src: CanvasImageSource,
  width: number,
  height: number,
  frame: HandFrame,
  req: ShadowRequest,
  t: number,
): ShadowResult {
  const start = performance.now();
  const done = (readings: ShadowReading[]) => ({ readings, ms: performance.now() - start, backgroundT: bgT });
  if (frame.landmarks.length === 0) {
    updateBackground(src, width, height, t);
    return done([]);
  }
  const { patchRadius } = CONFIG.shadow;
  const px = (p: Pt) => ({ x: p.x * width, y: p.y * height });
  const tips = frame.landmarks.flatMap((hand, h) =>
    req.tips.map((tip) => {
      const mcp = px(hand[tip - 3]);
      const pip = px(hand[tip - 2]);
      return { hand: h, tip, at: px(hand[tip]), unit: Math.hypot(pip.x - mcp.x, pip.y - mcp.y) };
    }),
  );
  const reach = (t: (typeof tips)[number]) => patchRadius * t.unit + 2;
  const x0 = Math.max(0, Math.floor(Math.min(...tips.map((t) => t.at.x - reach(t)))));
  const y0 = Math.max(0, Math.floor(Math.min(...tips.map((t) => t.at.y - reach(t)))));
  const x1 = Math.min(width, Math.ceil(Math.max(...tips.map((t) => t.at.x + reach(t)))));
  const y1 = Math.min(height, Math.ceil(Math.max(...tips.map((t) => t.at.y + reach(t)))));
  if (!tips.length || x1 - x0 < 2 || y1 - y0 < 2) return done([]);
  const g = grab("patch", src, x0, y0, x1, y1);
  const hands = handShapes(frame, px);
  const readings = tips.flatMap(({ hand, tip, at, unit }) => {
    if (!(unit > 0)) return [];
    const m = measure(g, hands, at, unit, req.dir, req.patches);
    return [{ ...m, hand, tip, shadow: m.shadow && { x: m.shadow.x / width, y: m.shadow.y / height } }];
  });
  return done(readings);
}
