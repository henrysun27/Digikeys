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
