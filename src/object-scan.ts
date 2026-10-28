// "Scan objects": Muse Spark lists the kinds of objects on the desk in one frame, SAM 3.1
// segments each listed name (all in parallel), the matches are merged into distinct objects
// (objects.ts), and each object's crop goes to Muse Spark, all at once, for its name,
// material and sound. Each object becomes a poly Zone on the desk plane.
import { CONFIG } from "./config.ts";
import type { Mat3, Pt } from "./geometry.ts";
import type { Zone } from "./layout.ts";
import { describeObjectCrop, listObjectsIn } from "./muse.ts";
import {
  checkDescription,
  checkObjectList,
  matchName,
  objectOutline,
  objectZones,
  outlineToBoard,
  selectObjects,
  soundName,
  type ListedObject,
  type ObjectDescription,
  type ObjectMatch,
} from "./objects.ts";
import { captureFrame, maskImage, maskPixels, segmentObjectsIn } from "./sam.ts";

export type ScanReport = {
  zones: Zone[];
  listed: (ListedObject & { matches: number })[]; // Muse Spark's list, with SAM matches per name
  found: string[]; // per object pad: "coffee mug (ceramic) → bell C6"
  skipped: string[]; // per SAM match not used, and why
  failedNames: string[]; // names whose SAM request failed, with the error
  listMs: number; // Muse Spark listing round trip
  segmentMs: number; // SAM round trip, all names in parallel
  describeMs: number; // all Muse Spark descriptions, in parallel
};

// The frame with the board outlined in magenta, as Muse Spark is told; corners in pixels.
function withBoard(frame: HTMLCanvasElement, corners: Pt[]): string {
  const c = document.createElement("canvas");
  c.width = frame.width;
  c.height = frame.height;
  const g = c.getContext("2d")!;
  g.drawImage(frame, 0, 0);
  g.strokeStyle = "#ff00ff";
  g.lineWidth = Math.max(2, c.height / 300);
  g.beginPath();
  corners.forEach((p, i) => (i === 0 ? g.moveTo(p.x, p.y) : g.lineTo(p.x, p.y)));
  g.closePath();
  g.stroke();
  return c.toDataURL("image/jpeg", CONFIG.muse.jpegQuality);
}

// The match's box plus a margin, from the unmirrored frame, with everything outside its mask
// dimmed so the model knows which thing is meant.
function cropOf(frame: HTMLCanvasElement, m: ObjectMatch): string {
  const { cropMargin, cropMinMarginPx, cropMinPx, cropMaxPx, cropDim, jpegQuality } = CONFIG.objects;
  const b = m.bounds;
  const margin = Math.max(cropMinMarginPx, cropMargin * Math.max(b.right - b.left, b.bottom - b.top));
  const x0 = Math.max(0, b.left - margin);
  const y0 = Math.max(0, b.top - margin);
  const x1 = Math.min(frame.width, b.right + margin);
  const y1 = Math.min(frame.height, b.bottom + margin);
  const side = Math.max(x1 - x0, y1 - y0);
  const s = Math.min(cropMaxPx, Math.max(cropMinPx, side)) / side;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round((x1 - x0) * s));
  c.height = Math.max(1, Math.round((y1 - y0) * s));
  const g = c.getContext("2d")!;
  g.drawImage(frame, x0, y0, x1 - x0, y1 - y0, 0, 0, c.width, c.height);
  const shade = document.createElement("canvas");
  shade.width = c.width;
  shade.height = c.height;
  const sg = shade.getContext("2d")!;
  sg.fillStyle = `rgba(0, 0, 0, ${cropDim})`;
  sg.fillRect(0, 0, c.width, c.height);
  sg.globalCompositeOperation = "destination-out";
  const mask = maskImage(m, [0, 0, 0, 255]);
  sg.drawImage(mask, (b.left - x0) * s, (b.top - y0) * s, (b.right - b.left) * s, (b.bottom - b.top) * s);
  g.drawImage(shade, 0, 0);
  return c.toDataURL("image/jpeg", jpegQuality);
}

// corners: the calibrated board, cam coords. progress gets a status line at each step.
export async function scanObjects(
  video: HTMLVideoElement,
  camToBoard: Mat3,
  corners: Pt[],
  progress: (text: string) => void,
): Promise<ScanReport> {
  const frame = captureFrame(video);
  const { width, height } = frame;
  const board = corners.map((p) => ({ x: p.x * width, y: p.y * height }));

  progress("Scanning objects: Muse Spark listing what is on the desk…");
  let started = performance.now();
  const reply = await listObjectsIn(withBoard(frame.canvas, board));
  const listMs = performance.now() - started;
  const names = checkObjectList(reply.list);
  if (typeof names === "string") throw new Error(`Muse Spark's object list: ${names}`);
  const report: ScanReport = {
    zones: [],
    listed: names.map((n) => ({ ...n, matches: 0 })),
    found: [],
    skipped: [],
    failedNames: [],
    listMs,
    segmentMs: 0,
    describeMs: 0,
  };
  if (names.length === 0) return report;

  progress(`Scanning objects: SAM 3.1 segmenting ${names.map((n) => n.name).join(", ")}…`);
  started = performance.now();
  const seg = await segmentObjectsIn(frame.image, names.map((n) => n.name));
  report.segmentMs = performance.now() - started;
  for (const l of report.listed) l.matches = seg.objects.filter((o) => o.prompt === l.name).length;
  report.failedNames = seg.failed.map((f) => `"${f.prompt}": ${f.error}`);

  const { kept, dropped } = selectObjects(seg.objects, width, height, board);
  report.skipped = dropped.map((d) => `${matchName(d.match)}: ${d.why}`);
  const camCenter = {
    x: corners.reduce((s, p) => s + p.x, 0) / corners.length,
    y: corners.reduce((s, p) => s + p.y, 0) / corners.length,
  };
  const placed: { match: ObjectMatch; pts: [number, number][] }[] = [];
  for (const match of kept) {
    const pts = outlineToBoard(objectOutline(match), width, height, camToBoard, camCenter);
    if (typeof pts === "string") report.skipped.push(`${matchName(match)}: ${pts}`);
    else placed.push({ match, pts });
  }

  let named = 0;
  const show = () => progress(`Scanning objects: Muse Spark picking sounds, ${named} of ${placed.length}…`);
  show();
  started = performance.now();
  const replies = await Promise.all(
    placed.map(async ({ match }) => {
      try {
        const r = await describeObjectCrop(cropOf(frame.canvas, match), match.prompt);
        return checkDescription(r.description);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      } finally {
        named++;
        show();
      }
    }),
  );
  report.describeMs = performance.now() - started;

  // An object Muse Spark couldn't describe stays playable under its listed name and a plain
  // sound.
  const items: { pts: [number, number][]; area: number; desc: ObjectDescription }[] = [];
  placed.forEach(({ match, pts }, i) => {
    const reply = replies[i];
    const failed = typeof reply === "string";
    const desc: ObjectDescription = failed
      ? { name: match.prompt, material: "", sound: { type: "voice", voice: "woodblock", note: "G5" } }
      : reply;
    items.push({ pts, area: maskPixels(match), desc });
    const material = desc.material ? ` (${desc.material})` : "";
    const why = failed ? ` (no sound from Muse Spark: ${reply})` : "";
    report.found.push(`${desc.name}${material} → ${soundName(desc.sound)}${why}`);
  });
  report.zones = objectZones(items);
  return report;
}
