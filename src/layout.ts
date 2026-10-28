import { CONFIG } from "./config.ts";
import { pointInPolygon, type Pt } from "./geometry.ts";

// Everything playable is a Zone in board coordinates (0-1 after the homography).
export type Shape =
  | { kind: "rect"; x: number; y: number; w: number; h: number }
  | { kind: "poly"; pts: [number, number][] };
// What instruments (presets and Muse Spark specs) play.
export type InstrumentSound =
  | { type: "note"; note: string } // e.g. "C4"
  | { type: "drum"; sample: string }; // e.g. "snare"
// Object pads can also play a synthesized voice (OBJECT_VOICES) at a pitch; unpitched
// voices ignore the note.
export type Sound = InstrumentSound | { type: "voice"; voice: string; note: string };
// z: hit-test priority where zones overlap; the highest z under a point wins and is drawn on
// top (black keys z 1 over white keys z 0). Zones at the same z must not overlap.
export type Zone = { id: string; label: string; shape: Shape; sound: Sound; z: number };
export type Layout = { instrument: string; zones: Zone[] };

// Every drum sample sound.ts loads; generated layouts may only use these.
export const DRUM_SAMPLES = ["kick", "snare", "hihat", "tom1", "tom2", "tom3"];
// Synthesized voices for object pads (sound.ts), each with its pitch when none is given.
// Unpitched ones have a null default.
export const OBJECT_VOICES: Record<string, string | null> = {
  bell: "C6", // ceramic, porcelain
  chime: "E6", // glass
  woodblock: "G5", // wood
  pluck: "C5", // plastic
  metal: null, // metal
  shaker: null, // fabric, soft things
};

// Layouts, presets and generated alike, are in the player's frame: x from the player's
// left (0) to right (1), y from the far edge (0) to the near edge (1). orientLayout
// (orientation.ts) places them on the board for where the player sits. The presets and
// every spec-built layout come from the layout engine in instrument.ts.

// Sharps and flats: drawn dark, like black keys.
export const isAccidental = (z: Zone) => z.sound.type === "note" && /^[A-G][#b]/.test(z.sound.note);

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

// Board coords may stray outside 0-1 by boundsTolerance; those are clamped.
function inBoard(v: unknown): number | null {
  const tol = CONFIG.layoutLimits.boundsTolerance;
  return isNum(v) && v >= -tol && v <= 1 + tol ? Math.min(1, Math.max(0, v)) : null;
}

function checkShape(v: unknown): Shape | string {
  if (!isObj(v)) return "has no shape";
  if (v.kind === "rect") {
    const x = inBoard(v.x);
    const y = inBoard(v.y);
    const right = isNum(v.x) && isNum(v.w) ? inBoard(v.x + v.w) : null;
    const bottom = isNum(v.y) && isNum(v.h) ? inBoard(v.y + v.h) : null;
    if (x === null || y === null || right === null || bottom === null) return "is outside the board";
    if (right <= x || bottom <= y) return "has no width or height";
    return { kind: "rect", x, y, w: right - x, h: bottom - y };
  }
  if (v.kind === "poly") {
    const { maxPolyPts } = CONFIG.layoutLimits;
    if (!Array.isArray(v.pts) || v.pts.length < 3 || v.pts.length > maxPolyPts) {
      return `needs 3-${maxPolyPts} polygon points`;
    }
    const pts: [number, number][] = [];
    for (const p of v.pts) {
      const x = Array.isArray(p) && p.length === 2 ? inBoard(p[0]) : null;
      const y = Array.isArray(p) && p.length === 2 ? inBoard(p[1]) : null;
      if (x === null || y === null) return "is outside the board";
      pts.push([x, y]);
    }
    return { kind: "poly", pts };
  }
  return `has an unknown shape kind "${String(v.kind)}"`;
}

export function checkSound(v: unknown): InstrumentSound | string {
  if (!isObj(v)) return "has no sound";
  if (v.type === "drum") {
    const sample = v.sample;
    if (typeof sample === "string" && DRUM_SAMPLES.includes(sample)) return { type: "drum", sample };
    return `uses an unknown drum sample "${String(sample)}"`;
  }
  if (v.type === "note") {
    const [lo, hi] = CONFIG.layoutLimits.noteOctaves;
    const m = typeof v.note === "string" ? /^([A-G](?:#|b)?)(\d)$/.exec(v.note) : null;
    if (m && Number(m[2]) >= lo && Number(m[2]) <= hi) return { type: "note", note: v.note as string };
    return `has note "${String(v.note)}", not a note name like C4 in octaves ${lo}-${hi}`;
  }
  return `has an unknown sound type "${String(v.type)}"`;
}

// Checks a layout (from a model, or built from a spec, in the player's frame) and returns
// it cleaned up, or why it can't be used: zones inside 0-1, at least minZoneSide deep, at
// least minZoneArea left visible by the zones above them, and not overlapping zones at the
// same z (a higher z may cover a lower one: it wins taps there). Zones narrower than
// minZoneWidth are allowed, since explicit requests win, but reported as a warning. Areas
// and overlaps are measured by hit-testing a checkGrid x checkGrid grid of sample points,
// so rects and polys are treated alike and zones sharing an edge don't count as overlapping.
export function checkLayout(v: unknown): { layout: Layout; warning: string | null } | { problem: string } {
  const { maxZones, minZoneSide, minZoneWidth, minZoneArea, maxOverlap, checkGrid } = CONFIG.layoutLimits;
  if (!isObj(v) || !Array.isArray(v.zones)) return { problem: "no zones" };
  if (v.zones.length === 0 || v.zones.length > maxZones) {
    return { problem: `${v.zones.length} zones (allowed 1-${maxZones})` };
  }
  const zones: Zone[] = [];
  const ids = new Set<string>();
  for (const [i, z] of v.zones.entries()) {
    const label = isObj(z) && typeof z.label === "string" && z.label.trim() ? z.label.trim() : `zone ${i + 1}`;
    const shape = checkShape(isObj(z) ? z.shape : null);
    if (typeof shape === "string") return { problem: `"${label}" ${shape}` };
    const sound = checkSound(isObj(z) ? z.sound : null);
    if (typeof sound === "string") return { problem: `"${label}" ${sound}` };
    // Ids only need to be unique; duplicates get a suffix rather than a rejection.
    let id = isObj(z) && typeof z.id === "string" && z.id ? z.id : label;
    for (let n = 2; ids.has(id); n++) id = `${id}-${n}`;
    ids.add(id);
    const zv = isObj(z) && isNum(z.z) ? Math.round(z.z) : 0;
    zones.push({ id, label, shape, sound, z: zv });
  }

  let narrow = 0;
  let narrowest = Infinity;
  for (const z of zones) {
    const pts = shapeOutline(z.shape);
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    // The epsilon lets a zone sized exactly at the minimum through despite float rounding.
    if (h < minZoneSide - 1e-6) {
      return { problem: `"${z.label}" is ${h.toFixed(3)} deep, under the ${minZoneSide} minimum` };
    }
    if (w < minZoneWidth - 1e-6) narrow++;
    narrowest = Math.min(narrowest, w);
  }
  const warning = narrow
    ? `${narrow} of ${zones.length} zones are narrower than a finger (${minZoneWidth} of the board; narrowest ${narrowest.toFixed(3)})`
    : null;

  const n = zones.length;
  const area = new Array<number>(n).fill(0); // in grid samples
  const visible = new Array<number>(n).fill(0); // samples where no higher zone covers it
  const shared = new Array<number>(n * n).fill(0); // same-z pairs only
  const inside: number[] = [];
  for (let gy = 0; gy < checkGrid; gy++) {
    for (let gx = 0; gx < checkGrid; gx++) {
      const p = { x: (gx + 0.5) / checkGrid, y: (gy + 0.5) / checkGrid };
      inside.length = 0;
      zones.forEach((z, i) => {
        if (inShape(p, z.shape)) inside.push(i);
      });
      const top = Math.max(...inside.map((i) => zones[i].z));
      for (const i of inside) {
        area[i]++;
        if (zones[i].z === top) visible[i]++;
        for (const j of inside) if (j > i && zones[j].z === zones[i].z) shared[i * n + j]++;
      }
    }
  }
  const samples = checkGrid * checkGrid;
  for (let i = 0; i < n; i++) {
    if (visible[i] / samples < minZoneArea) {
      const covered = visible[i] < area[i] ? " left uncovered by the zones above it" : "";
      return { problem: `"${zones[i].label}" has ${((visible[i] / samples) * 100).toFixed(2)}% of the board${covered}, under the ${minZoneArea * 100}% minimum` };
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const frac = shared[i * n + j] / Math.min(area[i], area[j]);
      if (frac > maxOverlap) {
        return { problem: `"${zones[i].label}" and "${zones[j].label}" overlap (${(frac * 100).toFixed(0)}% of the smaller)` };
      }
    }
  }
  const instrument = typeof v.instrument === "string" && v.instrument.trim() ? v.instrument.trim() : "generated";
  return { layout: { instrument, zones }, warning };
}

export function shapeOutline(shape: Shape): Pt[] {
  if (shape.kind === "poly") return shape.pts.map(([x, y]) => ({ x, y }));
  const { x, y, w, h } = shape;
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

export function shapeCenter(shape: Shape): Pt {
  if (shape.kind === "rect") return { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 };
  const n = shape.pts.length;
  return {
    x: shape.pts.reduce((s, [x]) => s + x, 0) / n,
    y: shape.pts.reduce((s, [, y]) => s + y, 0) / n,
  };
}

function inShape(p: Pt, shape: Shape): boolean {
  if (shape.kind === "rect") {
    return p.x >= shape.x && p.x < shape.x + shape.w && p.y >= shape.y && p.y < shape.y + shape.h;
  }
  return pointInPolygon(p, shapeOutline(shape));
}

// The highest-z zone under p (board coordinates); the earliest on a tie.
export function hitTest(layout: Layout, p: Pt): Zone | null {
  let hit: Zone | null = null;
  for (const z of layout.zones) if ((!hit || z.z > hit.z) && inShape(p, z.shape)) hit = z;
  return hit;
}

type Box = { x0: number; y0: number; x1: number; y1: number };
function bounds(shape: Shape): Box {
  const pts = shapeOutline(shape);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

// Zones low z first, each with the higher-z zones whose bounds overlap it, for drawing:
// each zone is drawn clipped to what those leave visible. Cached per layout.
const stacks = new WeakMap<Layout, { zone: Zone; above: Zone[] }[]>();
export function zStack(layout: Layout): { zone: Zone; above: Zone[] }[] {
  let stack = stacks.get(layout);
  if (!stack) {
    const boxes = new Map(layout.zones.map((z) => [z, bounds(z.shape)]));
    const meets = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
    stack = [...layout.zones]
      .sort((a, b) => a.z - b.z)
      .map((zone) => ({
        zone,
        above: layout.zones.filter((o) => o.z > zone.z && meets(boxes.get(o)!, boxes.get(zone)!)),
      }));
    stacks.set(layout, stack);
  }
  return stack;
}

// Where to label a zone and aim taps at it: the middle of its part that wins hit-tests
// (sampled on an anchorGrid grid), or its shape's center if that misses. A white key's
// anchor sits on its uncovered near part, below the black keys. Cached per layout.
const anchors = new WeakMap<Layout, Map<string, Pt>>();
export function zoneAnchor(layout: Layout, zone: Zone): Pt {
  let map = anchors.get(layout);
  if (!map) {
    const g = CONFIG.layoutLimits.anchorGrid;
    const sums = new Map<string, { x: number; y: number; n: number }>();
    for (let gy = 0; gy < g; gy++) {
      for (let gx = 0; gx < g; gx++) {
        const p = { x: (gx + 0.5) / g, y: (gy + 0.5) / g };
        const hit = hitTest(layout, p);
        if (!hit) continue;
        const s = sums.get(hit.id) ?? { x: 0, y: 0, n: 0 };
        s.x += p.x;
        s.y += p.y;
        s.n++;
        sums.set(hit.id, s);
      }
    }
    map = new Map([...sums].map(([id, s]) => [id, { x: s.x / s.n, y: s.y / s.n }]));
    anchors.set(layout, map);
  }
  const a = map.get(zone.id) ?? shapeCenter(zone.shape);
  // A concave visible part (a white key between two black keys) can have its mean outside
  // itself; then the shape's center is used.
  return hitTest(layout, a)?.id === zone.id ? a : shapeCenter(zone.shape);
}
