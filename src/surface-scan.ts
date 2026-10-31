// Detect surface. With a prompt typed, SAM 3.1 segments that phrase. With none, Muse Spark
// names the flat surfaces in view (best first), SAM 3.1 segments every name at once, and each
// name's largest match becomes a candidate if four corners fit it closely and pass the checks;
// names that found the same surface are merged into the better-ranked one.
import { checkCorners, orderCorners } from "./calibration.ts";
import { CONFIG } from "./config.ts";
import { convexHull, fitQuad, pointInPolygon, polygonArea, type Pt } from "./geometry.ts";
import { listSurfacesIn } from "./muse.ts";
import { captureFrame, maskArea, maskOutline, maskPixels, segmentObjectsIn, type SamObject } from "./sam.ts";

// A possible playing surface. name: the phrase SAM found it under; reason: Muse Spark's (null
// for a typed prompt). width, height: the frame's pixels. corners: cam coords in click order,
// null if no quad fits; fit: quad area / mask area (1 = exactly four-sided); frac: share of
// the frame the mask covers; problem: why it can't be used, null if it can.
export type SurfaceCandidate = {
  name: string;
  reason: string | null;
  width: number;
  height: number;
  pick: SamObject;
  corners: Pt[] | null;
  fit: number | null;
  frac: number;
  problem: string | null;
};

export type SurfaceScan = {
  listed: { name: string; reason: string }[]; // Muse Spark's list, best first
  candidates: SurfaceCandidate[]; // usable ones, best first
  dropped: string[]; // per listed name not kept, and why
  failed: string[]; // names whose SAM request failed
  listMs: number;
  segmentMs: number;
};

// Playing-surface corners from a SAM mask: convex hull, then the enclosing quad, in click
// order, with quad area / mask area.
function fitSurface(width: number, height: number, pick: SamObject): { corners: Pt[]; fit: number } | null {
  const { pts, area } = maskOutline(pick);
  const quad = fitQuad(convexHull(pts));
  if (!quad) return null;
  const norm = quad.map((p) => ({ x: p.x / width, y: p.y / height }));
  return { corners: orderCorners(norm, width / height), fit: Math.abs(polygonArea(quad)) / area };
}

// One match judged as the playing surface: big enough, four corners fit, corners pass.
export function surfaceCandidate(
  name: string,
  reason: string | null,
  width: number,
  height: number,
  pick: SamObject,
): SurfaceCandidate {
  const frac = maskPixels(pick) / (width * height);
  const fitted = fitSurface(width, height, pick);
  const problem =
    frac < CONFIG.sam.minSurfaceFrac
      ? `it covers only ${(frac * 100).toFixed(1)}% of the frame`
      : !fitted
        ? "couldn't fit 4 corners to it"
        : checkCorners(fitted.corners);
  return { name, reason, width, height, pick, corners: fitted?.corners ?? null, fit: fitted?.fit ?? null, frac, problem };
}

// The largest of a name's matches.
export const largest = (objects: SamObject[]): SamObject | null =>
  objects.reduce<SamObject | null>((a, o) => (!a || maskArea(o) > maskArea(a) ? o : a), null);

// Checks Muse Spark's {surfaces: [{name, reason}]}: trimmed, deduplicated, at most
// maxCandidates, in its order.
export function checkSurfaceList(v: unknown): { name: string; reason: string }[] | string {
  const list = typeof v === "object" && v !== null ? (v as Record<string, unknown>).surfaces : null;
  if (!Array.isArray(list)) return "no surface list";
  const out: { name: string; reason: string }[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const { name, reason } = item as Record<string, unknown>;
    const n = typeof name === "string" ? name.trim().slice(0, CONFIG.server.maxPromptChars) : "";
    if (!n || out.some((o) => o.name.toLowerCase() === n.toLowerCase())) continue;
    out.push({ name: n, reason: typeof reason === "string" ? reason.trim().slice(0, 60) : "" });
  }
  return out.slice(0, CONFIG.sam.autoSurface.maxCandidates);
}

// Intersection over union of two quads (cam coords), on an overlapGrid-wide grid of cells.
function quadIoU(a: Pt[], b: Pt[], aspect: number): number {
  const cols = CONFIG.sam.autoSurface.overlapGrid;
  const rows = Math.max(1, Math.round(cols / aspect));
  let both = 0;
  let either = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const p = { x: (i + 0.5) / cols, y: (j + 0.5) / rows };
      const inA = pointInPolygon(p, a);
      const inB = pointInPolygon(p, b);
      if (inA && inB) both++;
      if (inA || inB) either++;
    }
  }
  return either ? both / either : 0;
}

// The automatic path. progress gets a status line as each model starts.
export async function scanSurfaces(video: HTMLVideoElement, progress: (text: string) => void): Promise<SurfaceScan> {
  const frame = captureFrame(video);
  const { width, height } = frame;
  progress("Muse Spark is looking for flat surfaces…");
  let started = performance.now();
  const reply = await listSurfacesIn(frame.image);
  const listMs = performance.now() - started;
  const listed = checkSurfaceList(reply.list);
  if (typeof listed === "string") throw new Error(`Muse Spark's surface list: ${listed}`);
  const scan: SurfaceScan = { listed, candidates: [], dropped: [], failed: [], listMs, segmentMs: 0 };
  if (listed.length === 0) return scan;

  progress(`SAM 3.1 is outlining ${listed.map((l) => l.name).join(", ")}…`);
  started = performance.now();
  const seg = await segmentObjectsIn(frame.image, listed.map((l) => l.name));
  scan.segmentMs = performance.now() - started;
  scan.failed = seg.failed.map((f) => `"${f.prompt}": ${f.error}`);
  for (const { name, reason } of listed) {
    if (seg.failed.some((f) => f.prompt === name)) continue;
    const pick = largest(seg.objects.filter((o) => o.prompt === name));
    if (!pick) {
      scan.dropped.push(`${name}: SAM 3.1 found none`);
      continue;
    }
    const c = surfaceCandidate(name, reason, width, height, pick);
    if (c.problem) {
      scan.dropped.push(`${name}: ${c.problem}`);
      continue;
    }
    // A quad much bigger than its mask is a surface with its edges hidden or cut off (the
    // bare desk, around everything on it): no playing area, and on the stage it would cover
    // the frame and catch every click meant for the corners.
    if (c.fit! > CONFIG.sam.looseFitRatio) {
      scan.dropped.push(`${name}: loose fit, quad ${c.fit!.toFixed(2)}× the mask (edges hidden or not four-sided)`);
      continue;
    }
    const same = scan.candidates.find((k) => quadIoU(k.corners!, c.corners!, width / height) > CONFIG.sam.autoSurface.sameSurfaceIoU);
    if (same) {
      scan.dropped.push(`${name}: the same surface as ${same.name}`);
      continue;
    }
    scan.candidates.push(c);
  }
  return scan;
}
