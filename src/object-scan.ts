// "Scan objects": one frame goes to SAM 3.1 with every generic phrase, the matches are merged
// into distinct objects (objects.ts), and each object's crop goes to Muse Spark, all at
// once, for its name, material and sound. Each object becomes a poly Zone on the desk plane.
import { CONFIG } from "./config.ts";
import type { Mat3, Pt } from "./geometry.ts";
import type { Zone } from "./layout.ts";
import { describeObjectCrop } from "./muse.ts";
import {
  checkDescription,
  matchName,
  objectOutline,
  objectZones,
  outlineToBoard,
  selectObjects,
  soundName,
  type ObjectDescription,
  type ObjectMatch,
} from "./objects.ts";
import { captureFrame, maskImage, maskPixels, segmentObjectsIn } from "./sam.ts";

export type ScanReport = {
  zones: Zone[];
  found: string[]; // per object pad: "coffee mug (ceramic) → bell C6"
  skipped: string[]; // per match not used, and why
  matches: number; // SAM matches over all phrases
  failedPhrases: string[];
  segmentMs: number; // SAM round trip
  describeMs: number; // all Muse Spark calls, in parallel
};

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
  const phrases = CONFIG.objects.prompts.length;
  progress(`Scanning objects: SAM 3.1 with ${phrases} phrases…`);
  const segStarted = performance.now();
  const seg = await segmentObjectsIn(frame.image);
  const segmentMs = performance.now() - segStarted;

  const board = corners.map((p) => ({ x: p.x * width, y: p.y * height }));
  const { kept, dropped } = selectObjects(seg.objects, width, height, board);
  const skipped = dropped.map((d) => `${matchName(d.match)}: ${d.why}`);
  const camCenter = {
    x: corners.reduce((s, p) => s + p.x, 0) / corners.length,
    y: corners.reduce((s, p) => s + p.y, 0) / corners.length,
  };
  const placed: { match: ObjectMatch; pts: [number, number][] }[] = [];
  for (const match of kept) {
    const pts = outlineToBoard(objectOutline(match), width, height, camToBoard, camCenter);
    if (typeof pts === "string") skipped.push(`${matchName(match)}: ${pts}`);
    else placed.push({ match, pts });
  }

  let named = 0;
  const show = () => progress(`Scanning objects: Muse Spark naming ${named} of ${placed.length}…`);
  show();
  const descStarted = performance.now();
  const replies = await Promise.all(
    placed.map(async ({ match }) => {
      try {
        const r = await describeObjectCrop(cropOf(frame.canvas, match));
        return checkDescription(r.description);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      } finally {
        named++;
        show();
      }
    }),
  );
  const describeMs = performance.now() - descStarted;

  // An object Muse Spark couldn't describe stays playable under a plain name and sound.
  const items: { pts: [number, number][]; area: number; desc: ObjectDescription }[] = [];
  const found: string[] = [];
  placed.forEach(({ match, pts }, i) => {
    let desc = replies[i];
    if (typeof desc === "string") {
      skipped.push(`${matchName(match)}: Muse Spark failed (${desc}), kept as a plain woodblock`);
      desc = {
        isObject: true,
        name: `object ${items.length + 1}`,
        material: "",
        sound: { type: "voice", voice: "woodblock", note: "G5" },
      };
    } else if (!desc.isObject) {
      skipped.push(`${matchName(match)}: Muse Spark says not an object (${desc.name})`);
      return;
    }
    items.push({ pts, area: maskPixels(match), desc });
    const material = desc.material ? ` (${desc.material})` : "";
    found.push(`${desc.name}${material} → ${soundName(desc.sound)}`);
  });
  return {
    zones: objectZones(items),
    found,
    skipped,
    matches: seg.objects.length,
    failedPhrases: seg.failed.map((f) => `"${f.prompt}": ${f.error}`),
    segmentMs,
    describeMs,
  };
}
