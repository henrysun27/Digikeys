import { CONFIG } from "./config.ts";
import { cross, dist, homography, type Mat3, type Pt } from "./geometry.ts";

// Corners are clicked in on-screen order (as seen in the mirrored view); the first one
// becomes board (0,0).
export const CORNER_NAMES = ["top left", "top right", "bottom right", "bottom left"];
const BOARD_CORNERS: Pt[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

export class Calibration {
  // Raw (unmirrored) camera coords normalized to 0-1, the same space as hand landmarks.
  corners: Pt[] = [];
  boardToCam: Mat3 | null = null;
  camToBoard: Mat3 | null = null;

  get done(): boolean {
    return this.corners.length === 4;
  }

  // Adds the next corner. Returns why it was rejected, or null if accepted.
  add(p: Pt): string | null {
    if (this.done) return null;
    const pts = [...this.corners, p];
    const problem = checkLast(pts);
    if (problem) return problem;
    this.corners = pts;
    if (this.done) {
      this.solve();
      this.save();
    }
    return null;
  }

  // Replaces the calibration with 4 corners at once (from surface detection), in
  // CORNER_NAMES order. Returns why they were rejected, or null if accepted.
  set(pts: Pt[]): string | null {
    const problem = checkCorners(pts);
    if (problem) return problem;
    this.corners = [...pts];
    this.solve();
    this.save();
    return null;
  }

  reset() {
    this.corners = [];
    this.boardToCam = null;
    this.camToBoard = null;
    try {
      localStorage.removeItem(CONFIG.calibration.storageKey);
    } catch {}
  }

  load() {
    try {
      const raw = localStorage.getItem(CONFIG.calibration.storageKey);
      if (!raw) return;
      const pts: unknown = JSON.parse(raw);
      if (!isCornerList(pts)) return;
      if (checkCorners(pts)) return;
      this.corners = pts;
      this.solve();
    } catch {}
  }

  private save() {
    try {
      localStorage.setItem(CONFIG.calibration.storageKey, JSON.stringify(this.corners));
    } catch {}
  }

  private solve() {
    this.boardToCam = homography(BOARD_CORNERS, this.corners);
    this.camToBoard = homography(this.corners, BOARD_CORNERS);
  }
}

// Checks a full set of 4 corners as if they had been clicked in order.
export function checkCorners(pts: Pt[]): string | null {
  if (pts.length !== 4) return "Need exactly 4 corners";
  for (let i = 1; i <= 4; i++) {
    const problem = checkLast(pts.slice(0, i));
    if (problem) return problem;
  }
  return null;
}

// Puts a quad (raw camera coords, any winding) into click order: going clockwise on
// screen, starting from the on-screen top-left corner. The view is mirrored, so screen x
// is 1 - x; aspect (width / height) makes the top-left pick use true proportions.
export function orderCorners(quad: Pt[], aspect: number): Pt[] {
  const screen = quad.map((p) => ({ x: (1 - p.x) * aspect, y: p.y }));
  // Clockwise on screen (y down) is a positive cross product at every corner.
  let order = [0, 1, 2, 3];
  if (cross(screen[0], screen[1], screen[2]) < 0) order = order.reverse();
  const first = order.reduce((a, i) => (screen[i].x + screen[i].y < screen[a].x + screen[a].y ? i : a));
  const k = order.indexOf(first);
  return [...order.slice(k), ...order.slice(0, k)].map((i) => quad[i]);
}

// Checks the newest point against the ones before it.
function checkLast(pts: Pt[]): string | null {
  const { minCornerDist, minCornerCross } = CONFIG.calibration;
  const last = pts[pts.length - 1];
  for (let i = 0; i < pts.length - 1; i++) {
    if (dist(pts[i], last) < minCornerDist) return `Too close to corner ${i + 1}`;
  }
  if (pts.length === 3 && Math.abs(cross(pts[0], pts[1], pts[2])) < minCornerCross) {
    return "Corners 1-3 are in a line";
  }
  if (pts.length === 4) {
    const turns = pts.map((_, i) => cross(pts[i], pts[(i + 1) % 4], pts[(i + 2) % 4]));
    if (turns.some((t) => Math.abs(t) < minCornerCross)) return "Three corners are in a line";
    if (turns.some((t) => Math.sign(t) !== Math.sign(turns[0]))) {
      return "Edges cross or bend inward; go around the edge in order";
    }
  }
  return null;
}

function isCornerList(v: unknown): v is Pt[] {
  return (
    Array.isArray(v) &&
    v.length === 4 &&
    v.every((p) => typeof p?.x === "number" && typeof p?.y === "number")
  );
}
