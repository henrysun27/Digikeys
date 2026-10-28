// Object pads (milestone 7): Muse Spark lists the kinds of objects on the desk, SAM 3.1's
// matches for those names are merged into distinct objects, each object's outline goes onto
// the desk plane through the board's homography, and Muse Spark's description of its crop
// picks the sound. Free of DOM calls so it runs on recorded matches in Node too; the browser
// side is object-scan.ts.
import { CONFIG } from "./config.ts";
import { convexHull, cross, pointInPolygon, type Mat3, type Pt } from "./geometry.ts";
import { DRUM_SAMPLES, OBJECT_VOICES, type Sound, type Zone } from "./layout.ts";
import { maskOutline, type SamObject } from "./sam.ts";

// A kind of object Muse Spark saw on the desk: the name is SAM 3.1's text prompt.
export type ListedObject = { name: string; count: number };

// Checks Muse Spark's list ({objects: [{name, count}]}): names trimmed, lowercased for
// comparison and deduplicated, at most maxNames and maxPromptChars each; a count under 1
// becomes 1.
export function checkObjectList(v: unknown): ListedObject[] | string {
  const list = typeof v === "object" && v !== null ? (v as Record<string, unknown>).objects : null;
  if (!Array.isArray(list)) return "no object list";
  const out: ListedObject[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const { name, count } = item as Record<string, unknown>;
    const n = typeof name === "string" ? name.trim().slice(0, CONFIG.server.maxPromptChars) : "";
    if (!n || out.some((o) => o.name.toLowerCase() === n.toLowerCase())) continue;
    out.push({ name: n, count: typeof count === "number" && count >= 1 ? Math.round(count) : 1 });
  }
  return out.slice(0, CONFIG.objects.maxNames);
}

// A SAM match and the name that found it.
export type ObjectMatch = SamObject & { prompt: string };

const confidence = (m: ObjectMatch) => m.confidence ?? 0;
export const matchName = (m: ObjectMatch) => `"${m.prompt}" #${m.id}`;

// Cells of an overlapGrid-wide grid over the frame whose centers fall in the mask.
function cells(m: ObjectMatch, cols: number, rows: number, cell: number): Set<number> {
  const out = new Set<number>();
  const b = m.bounds;
  const { width: W, height: H, data } = m.mask;
  const sx = W / (b.right - b.left);
  const sy = H / (b.bottom - b.top);
  const gx0 = Math.max(0, Math.floor(b.left / cell));
  const gx1 = Math.min(cols, Math.ceil(b.right / cell));
  const gy0 = Math.max(0, Math.floor(b.top / cell));
  const gy1 = Math.min(rows, Math.ceil(b.bottom / cell));
  for (let gy = gy0; gy < gy1; gy++) {
    const my = Math.floor(((gy + 0.5) * cell - b.top) * sy);
    if (my < 0 || my >= H) continue;
    for (let gx = gx0; gx < gx1; gx++) {
      const mx = Math.floor(((gx + 0.5) * cell - b.left) * sx);
      if (mx >= 0 && mx < W && data[my * W + mx]) out.add(gy * cols + gx);
    }
  }
  return out;
}

function shared(a: Set<number>, b: Set<number>): number {
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  let n = 0;
  for (const c of small) if (big.has(c)) n++;
  return n;
}

// Picks distinct objects from all names' matches (frame width x height pixels). Size and
// shape never count: only the board itself is dropped (board: its corners in frame pixels,
// or null), along with matches that repeat a more confident one (sharing more than
// maxOverlap of the smaller: one object under two names), past maxObjects. dropped says
// why for each other match.
export function selectObjects(
  matches: ObjectMatch[],
  width: number,
  height: number,
  board: Pt[] | null,
): { kept: ObjectMatch[]; dropped: { match: ObjectMatch; why: string }[] } {
  const { maxOverlap, boardIoU, overlapGrid, maxObjects } = CONFIG.objects;
  const cols = overlapGrid;
  const cell = width / cols;
  const rows = Math.ceil(height / cell);
  const boardCells = new Set<number>();
  if (board) {
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        if (pointInPolygon({ x: (gx + 0.5) * cell, y: (gy + 0.5) * cell }, board)) boardCells.add(gy * cols + gx);
      }
    }
  }
  const dropped: { match: ObjectMatch; why: string }[] = [];
  const kept: { match: ObjectMatch; cells: Set<number> }[] = [];
  for (const match of [...matches].sort((a, b) => confidence(b) - confidence(a))) {
    const mine = cells(match, cols, rows, cell);
    // A mask smaller than a grid cell still takes part, as the cell at its center.
    if (mine.size === 0) {
      const b = match.bounds;
      const gx = Math.min(cols - 1, Math.floor((b.left + b.right) / 2 / cell));
      const gy = Math.min(rows - 1, Math.floor((b.top + b.bottom) / 2 / cell));
      mine.add(gy * cols + gx);
    }
    if (boardCells.size) {
      const inter = shared(mine, boardCells);
      const iou = inter / (mine.size + boardCells.size - inter);
      if (iou > boardIoU) {
        dropped.push({ match, why: `the board (IoU ${iou.toFixed(2)})` });
        continue;
      }
    }
    const same = kept.find((k) => shared(mine, k.cells) / Math.min(mine.size, k.cells.size) > maxOverlap);
    if (same) {
      dropped.push({ match, why: `same object as ${matchName(same.match)}` });
      continue;
    }
    if (kept.length >= maxObjects) {
      dropped.push({ match, why: `over the ${maxObjects}-object limit` });
      continue;
    }
    kept.push({ match, cells: mine });
  }
  return { kept: kept.map((k) => k.match), dropped };
}

// The match's outline in frame pixels: the convex hull of its despeckled mask (a hull is
// easier to hit than the exact edge, and a mug's handle loop needs no hole), simplified to
// maxPts vertices by repeatedly dropping the one spanning the smallest triangle.
export function objectOutline(m: ObjectMatch): Pt[] {
  const hull = convexHull(maskOutline(m).pts);
  while (hull.length > CONFIG.objects.maxPts) {
    let worst = 0;
    let least = Infinity;
    hull.forEach((p, i) => {
      const a = Math.abs(cross(hull[(i + hull.length - 1) % hull.length], p, hull[(i + 1) % hull.length]));
      if (a < least) {
        least = a;
        worst = i;
      }
    });
    hull.splice(worst, 1);
  }
  return hull;
}

// An outline in frame pixels onto the board plane (camToBoard maps 0-1 cam coords), or why
// not. The homography's w at a point is inversely proportional to its depth along the desk
// plane, so w relative to the board's center (camCenter, cam coords) must stay at least
// minDepthRatio: no point past the plane's horizon or so far toward it that it blows up.
export function outlineToBoard(
  outline: Pt[],
  width: number,
  height: number,
  camToBoard: Mat3,
  camCenter: Pt,
): [number, number][] | string {
  const H = camToBoard;
  const w = (p: Pt) => H[6] * p.x + H[7] * p.y + H[8];
  const center = w(camCenter);
  const { minDepthRatio } = CONFIG.objects;
  const pts: [number, number][] = [];
  for (const px of outline) {
    const p = { x: px.x / width, y: px.y / height };
    const d = w(p);
    if (d / center < minDepthRatio) {
      return `too far toward the desk plane's horizon (depth ratio ${(d / center).toFixed(2)})`;
    }
    pts.push([(H[0] * p.x + H[1] * p.y + H[2]) / d, (H[3] * p.x + H[4] * p.y + H[5]) / d]);
  }
  return pts;
}

// What Muse Spark says about one object's crop, checked.
export type ObjectDescription = { name: string; material: string; sound: Sound };

const PITCH = /^[A-G](?:#|b)?\d$/;

// Checks the model's reply ({name, material, sound, pitch}). sound is one of
// OBJECT_VOICES or DRUM_SAMPLES; a pitched voice without a usable pitch gets its default.
export function checkDescription(v: unknown): ObjectDescription | string {
  if (typeof v !== "object" || v === null) return "no description";
  const r = v as Record<string, unknown>;
  const str = (x: unknown, max: number) => (typeof x === "string" ? x.trim().slice(0, max) : "");
  const name = str(r.name, 32);
  if (!name) return "no name";
  const sound = str(r.sound, 20);
  let out: Sound;
  if (DRUM_SAMPLES.includes(sound)) out = { type: "drum", sample: sound };
  else if (sound in OBJECT_VOICES) {
    const [lo, hi] = CONFIG.layoutLimits.noteOctaves;
    const pitch = str(r.pitch, 4);
    const octave = Number(pitch.at(-1));
    const ok = PITCH.test(pitch) && octave >= lo && octave <= hi;
    out = { type: "voice", voice: sound, note: ok ? pitch : (OBJECT_VOICES[sound] ?? "C5") };
  } else return `unknown sound "${sound}"`;
  return { name, material: str(r.material, 24), sound: out };
}

// A sound's short name for labels and the status line: "bell C6", "snare".
export function soundName(s: Sound): string {
  if (s.type === "drum") return s.sample;
  if (s.type === "note") return s.note;
  return OBJECT_VOICES[s.voice] === null ? s.voice : `${s.voice} ${s.note}`;
}

// Poly zones for the objects (outline in board coords, area in frame pixels for z order):
// ids object-1.., labeled with the object's name. Smaller objects sit above larger ones.
export function objectZones(items: { pts: [number, number][]; area: number; desc: ObjectDescription }[]): Zone[] {
  const bySize = [...items].sort((a, b) => b.area - a.area);
  return items.map((it, i) => ({
    id: `object-${i + 1}`,
    label: it.desc.name,
    shape: { kind: "poly", pts: it.pts },
    sound: it.desc.sound,
    z: CONFIG.objects.baseZ + bySize.indexOf(it),
  }));
}
