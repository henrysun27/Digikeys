import { CONFIG } from "./config.ts";
import { applyH, type Mat3, type Pt } from "./geometry.ts";
import type { Layout, Shape } from "./layout.ts";

// Board edges, named by their corners (corner 1 is board (0,0), 2 is (1,0), 3 is (1,1),
// 4 is (0,1)).
export type Edge = "1-2" | "2-3" | "3-4" | "4-1";
export const EDGES: Edge[] = ["1-2", "2-3", "3-4", "4-1"];

// Where the player sits: near is the edge at their side, left the edge on their left.
export type Orientation = { near: Edge; left: Edge };

// Unit vector from the board center toward each edge, in board coords.
const OUTWARD: Record<Edge, Pt> = {
  "1-2": { x: 0, y: -1 },
  "2-3": { x: 1, y: 0 },
  "3-4": { x: 0, y: 1 },
  "4-1": { x: -1, y: 0 },
};

// The edge a board-coord direction points at most.
function edgeToward(d: Pt): Edge {
  if (Math.abs(d.x) > Math.abs(d.y)) return d.x > 0 ? "2-3" : "4-1";
  return d.y > 0 ? "3-4" : "1-2";
}

const OPPOSITE: Record<Edge, Edge> = { "1-2": "3-4", "2-3": "4-1", "3-4": "1-2", "4-1": "2-3" };

// The player's left edge when they sit at `near`. The camera sees the desk from above, so
// the raw camera image keeps the desk's handedness as seen from above: there, facing
// direction f, left is (f.y, -f.x) (y down). Board coords keep or flip that depending on
// the sign of the board-to-camera mapping's Jacobian (clicked corners follow the mirrored
// view, so they flip it).
export function leftEdge(near: Edge, boardToCam: Mat3): Edge {
  const c = applyH(boardToCam, { x: 0.5, y: 0.5 });
  const ex = applyH(boardToCam, { x: 0.51, y: 0.5 });
  const ey = applyH(boardToCam, { x: 0.5, y: 0.51 });
  const det = (ex.x - c.x) * (ey.y - c.y) - (ex.y - c.y) * (ey.x - c.x);
  const f = { x: -OUTWARD[near].x, y: -OUTWARD[near].y };
  return edgeToward(det > 0 ? { x: f.y, y: -f.x } : { x: -f.y, y: f.x });
}

// Where an edge appears in the mirrored on-screen view.
export function screenSide(edge: Edge, boardToCam: Mat3): string {
  const c = applyH(boardToCam, { x: 0.5, y: 0.5 });
  const o = OUTWARD[edge];
  const m = applyH(boardToCam, { x: 0.5 + o.x / 2, y: 0.5 + o.y / 2 });
  const dx = -(m.x - c.x); // mirrored
  const dy = m.y - c.y;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right of screen" : "left of screen";
  return dy > 0 ? "bottom of screen" : "top of screen";
}

// Before the hands have shown where the player sits: the edge nearest the top of the
// camera image, where a laptop webcam facing the player sees them.
export function topEdge(boardToCam: Mat3): Edge {
  const c = applyH(boardToCam, { x: 0.5, y: 0.5 });
  let best: Edge = "1-2";
  let bestY = Infinity;
  for (const e of EDGES) {
    const o = OUTWARD[e];
    const y = applyH(boardToCam, { x: 0.5 + o.x / 2, y: 0.5 + o.y / 2 }).y - c.y;
    if (y < bestY) [best, bestY] = [e, y];
  }
  return best;
}

// Layouts are written in the player's frame: x from the player's left (0) to right (1),
// y from the far edge (0) to the near edge (1). This maps a player-frame point to board
// coords. along(e, t) is the board coord that is 0 at the edge opposite e and 1 at e.
export function toBoardFrame(p: Pt, o: Orientation): Pt {
  const out = { x: 0, y: 0 };
  const along = (e: Edge, t: number) => {
    if (e === "1-2") out.y = 1 - t;
    else if (e === "3-4") out.y = t;
    else if (e === "2-3") out.x = t;
    else out.x = 1 - t;
  };
  along(o.near, p.y);
  along(OPPOSITE[o.left], p.x);
  return out;
}

function orientShape(s: Shape, o: Orientation): Shape {
  if (s.kind === "poly") {
    return { kind: "poly", pts: s.pts.map(([x, y]) => {
      const b = toBoardFrame({ x, y }, o);
      return [b.x, b.y];
    }) };
  }
  const a = toBoardFrame({ x: s.x, y: s.y }, o);
  const b = toBoardFrame({ x: s.x + s.w, y: s.y + s.h }, o);
  return { kind: "rect", x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

// A player-frame layout placed on the board for this orientation. Zone ids and sounds are
// kept, so flashes and refractories carry over.
export function orientLayout(l: Layout, o: Orientation): Layout {
  return { instrument: l.instrument, zones: l.zones.map((z) => ({ ...z, shape: orientShape(z.shape, o) })) };
}

// The board corner (1-4) at each corner of the player's frame.
export function playerCorners(o: Orientation) {
  const corner = (p: Pt) => {
    const b = toBoardFrame(p, o);
    return [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }].findIndex((c) => c.x === b.x && c.y === b.y) + 1;
  };
  return {
    farLeft: corner({ x: 0, y: 0 }),
    farRight: corner({ x: 1, y: 0 }),
    nearRight: corner({ x: 1, y: 1 }),
    nearLeft: corner({ x: 0, y: 1 }),
  };
}

// Which edge the player sits at, from hand pose: a hand's wrist is nearer the player than
// its fingertips, so fingertips-to-wrist points at the player. Each hand frame over the
// board adds that direction (board coords, unit length); over CONFIG.player.windowMs the
// mean picks the edge, once there are enough samples and they agree enough.
export class PlayerEdgeDetector {
  private samples: { t: number; d: Pt }[] = [];

  reset() {
    this.samples.length = 0;
  }

  // wrist and tips (index to pinky) in board coords.
  add(t: number, wrist: Pt, tips: Pt[]) {
    const { windowMs, minReach, boardMargin } = CONFIG.player;
    const tip = { x: tips.reduce((s, p) => s + p.x, 0) / tips.length, y: tips.reduce((s, p) => s + p.y, 0) / tips.length };
    const inside = (v: number) => v >= -boardMargin && v <= 1 + boardMargin;
    while (this.samples.length && this.samples[0].t < t - windowMs) this.samples.shift();
    if (!inside(tip.x) || !inside(tip.y)) return;
    const d = { x: wrist.x - tip.x, y: wrist.y - tip.y };
    const len = Math.hypot(d.x, d.y);
    if (len < minReach) return;
    this.samples.push({ t, d: { x: d.x / len, y: d.y / len } });
  }

  // The edge the mean direction points at, or null if there are too few samples or they
  // don't agree (mean length under minAgreement). count and agreement are for the panel.
  estimate(): { edge: Edge | null; count: number; agreement: number } {
    const n = this.samples.length;
    const sum = this.samples.reduce((s, { d }) => ({ x: s.x + d.x, y: s.y + d.y }), { x: 0, y: 0 });
    const agreement = n ? Math.hypot(sum.x, sum.y) / n : 0;
    const { minSamples, minAgreement } = CONFIG.player;
    const edge = n >= minSamples && agreement >= minAgreement ? edgeToward(sum) : null;
    return { edge, count: n, agreement };
  }
}
