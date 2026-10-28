export type Pt = { x: number; y: number };
// Row-major 3x3 matrix.
export type Mat3 = number[];

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Z component of (b - a) x (c - b): sign gives the turn direction at b, magnitude is
// twice the triangle area.
export function cross(a: Pt, b: Pt, c: Pt): number {
  return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
}

// Homography mapping each src[i] to dst[i], from exactly 4 point pairs.
export function homography(src: Pt[], dst: Pt[]): Mat3 {
  const rows: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x: u, y: v } = src[i];
    const { x, y } = dst[i];
    rows.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
    rows.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
  }
  return [...solve(rows), 1];
}

export function applyH(H: Mat3, p: Pt): Pt {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return {
    x: (H[0] * p.x + H[1] * p.y + H[2]) / w,
    y: (H[3] * p.x + H[4] * p.y + H[5]) / w,
  };
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

// Distance from p to the nearest point on the polygon's outline.
export function distToPolygon(p: Pt, poly: Pt[]): number {
  let best = Infinity;
  poly.forEach((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  });
  return best;
}

// Signed shoelace area; the sign gives the winding.
export function polygonArea(pts: Pt[]): number {
  let a = 0;
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  });
  return a / 2;
}

// Andrew's monotone chain. Collinear points are dropped.
export function convexHull(pts: Pt[]): Pt[] {
  const sorted = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length < 3) return sorted;
  const half = (list: Pt[]) => {
    const out: Pt[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop(); // the last point starts the other half
    return out;
  };
  return [...half(sorted), ...half(sorted.reverse())];
}

// Where line a1-a2 meets line b1-b2, or null if they are parallel.
function intersect(a1: Pt, a2: Pt, b1: Pt, b2: Pt): Pt | null {
  const d = (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x);
  if (Math.abs(d) < 1e-12) return null;
  const t = ((b1.x - a1.x) * (b2.y - b1.y) - (b1.y - a1.y) * (b2.x - b1.x)) / d;
  return { x: a1.x + t * (a2.x - a1.x), y: a1.y + t * (a2.y - a1.y) };
}

// Fits a quadrilateral around a convex polygon. Each step removes the edge whose removal
// adds the least area, extending its two neighboring edges until they meet. The result
// encloses the hull, and its corners sit where the long straight sides meet, so rounded
// or clipped corners don't pull them inward. Perspective is preserved: the sides need not
// be parallel.
export function fitQuad(hull: Pt[]): Pt[] | null {
  let poly = hull;
  while (poly.length > 4) {
    const n = poly.length;
    let best = -1;
    let bestCost = Infinity;
    let bestPt: Pt | null = null;
    for (let i = 0; i < n; i++) {
      const a = poly[(i + n - 1) % n];
      const b = poly[i];
      const c = poly[(i + 1) % n];
      const d = poly[(i + 2) % n];
      const p = intersect(a, b, d, c);
      // The neighbors must meet ahead of the removed edge, not behind it.
      if (!p || (p.x - b.x) * (b.x - a.x) + (p.y - b.y) * (b.y - a.y) < 0) continue;
      if ((p.x - c.x) * (c.x - d.x) + (p.y - c.y) * (c.y - d.y) < 0) continue;
      const cost = Math.abs(cross(b, p, c));
      if (cost < bestCost) {
        best = i;
        bestCost = cost;
        bestPt = p;
      }
    }
    if (!bestPt) return null;
    const next = (best + 1) % n;
    poly = poly.flatMap((q, j) => (j === best ? [bestPt] : j === next ? [] : [q]));
  }
  return poly.length === 4 ? poly : null;
}

// Gauss-Jordan elimination with partial pivoting on an n x (n+1) augmented matrix.
function solve(m: number[][]): number[] {
  const n = m.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const p = m[col][col];
    if (Math.abs(p) < 1e-12) throw new Error("degenerate homography");
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / p;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}
