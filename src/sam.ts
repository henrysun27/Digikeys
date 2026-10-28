import { CONFIG } from "./config.ts";
import type { Pt } from "./geometry.ts";

// Pixel coords of the captured frame; right and bottom are exclusive.
export type Bounds = { left: number; top: number; right: number; bottom: number };

export type SamObject = {
  id: string;
  confidence: number | null;
  bounds: Bounds;
  // Row-major 0/1 raster covering bounds.
  mask: { width: number; height: number; data: Uint8Array };
};

export type Segmentation = {
  prompt: string;
  width: number; // captured frame size, in camera pixels
  height: number;
  objects: SamObject[];
  ms: number; // round trip as seen by the browser
  serverMs: number;
};

type WireObject = Omit<SamObject, "mask"> & { mask: { width: number; height: number; bits: string } };

function unpackBits(bits: string, length: number): Uint8Array {
  const packed = Uint8Array.from(atob(bits), (c) => c.charCodeAt(0));
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (packed[i >> 3] >> (7 - (i & 7))) & 1;
  return out;
}

// The current video frame, unmirrored, at full camera resolution, and the canvas holding it.
export function captureFrame(video: HTMLVideoElement) {
  const c = document.createElement("canvas");
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext("2d")!.drawImage(video, 0, 0);
  return { image: c.toDataURL("image/jpeg", CONFIG.sam.jpegQuality), width: c.width, height: c.height, canvas: c };
}

const toSamObject = (o: WireObject): SamObject => ({
  ...o,
  mask: { width: o.mask.width, height: o.mask.height, data: unpackBits(o.mask.bits, o.mask.width * o.mask.height) },
});

// Object pads: each name as a text prompt on one frame, in parallel, through the server.
// Matches are tagged with their name; failed lists names that errored.
export async function segmentObjectsIn(
  image: string,
  prompts: string[],
): Promise<{
  objects: (SamObject & { prompt: string })[];
  failed: { prompt: string; error: string }[];
  serverMs: number;
}> {
  const res = await fetch("/api/objects/segment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image, prompts }),
  });
  const body = await res.json().catch(() => ({ error: `server returned ${res.status}` }));
  if (!res.ok) throw new Error(body.error ?? `server returned ${res.status}`);
  const objects = (body.objects as (WireObject & { prompt: string })[]).map((o) => ({ ...toSamObject(o), prompt: o.prompt }));
  return { objects, failed: body.failed, serverMs: body.ms };
}

// Sends the current frame to SAM 3.1 through the server.
export async function segmentFrame(video: HTMLVideoElement, prompt: string): Promise<Segmentation> {
  const started = performance.now();
  const { image, width, height } = captureFrame(video);
  const res = await fetch("/api/segment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image, prompt }),
  });
  const body = await res.json().catch(() => ({ error: `server returned ${res.status}` }));
  if (!res.ok) throw new Error(body.error ?? `server returned ${res.status}`);
  const objects = (body.objects as WireObject[]).map(toSamObject);
  return { prompt, width, height, objects, ms: performance.now() - started, serverMs: body.ms };
}

export function maskArea(o: SamObject): number {
  return o.mask.data.reduce((n, v) => n + v, 0);
}

// Drops 4-connected blobs smaller than minBlobFrac of the mask, so stray specks can't
// stretch the convex hull. Big pieces all stay: an arm across the surface splits the mask
// but both halves still belong to it.
function dropSpecks(o: SamObject): Uint8Array {
  const { width: W, data } = o.mask;
  const label = new Int32Array(data.length);
  const sizes = [0]; // by label; 0 = background
  const stack: number[] = [];
  for (let start = 0; start < data.length; start++) {
    if (!data[start] || label[start]) continue;
    const id = sizes.length;
    let size = 0;
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      size++;
      const x = i % W;
      for (const j of [i - W, i + W, x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1]) {
        if (j >= 0 && j < data.length && data[j] && !label[j]) {
          label[j] = id;
          stack.push(j);
        }
      }
    }
    sizes.push(size);
  }
  const min = CONFIG.sam.minBlobFrac * sizes.reduce((a, b) => a + b, 0);
  return Uint8Array.from(label, (l) => (l !== 0 && sizes[l] >= min ? 1 : 0));
}

// The despeckled mask in frame pixels: the pixel corners at both ends of each row (every
// convex hull vertex is among them) and its area.
export function maskOutline(o: SamObject): { pts: Pt[]; area: number } {
  const { width: W, height: H } = o.mask;
  const kept = dropSpecks(o);
  const b = o.bounds;
  const sx = (b.right - b.left) / W;
  const sy = (b.bottom - b.top) / H;
  const pts: Pt[] = [];
  for (let y = 0; y < H; y++) {
    const row = kept.subarray(y * W, (y + 1) * W);
    const first = row.indexOf(1);
    if (first < 0) continue;
    const last = row.lastIndexOf(1) + 1;
    for (const x of [first, last]) {
      for (const yy of [y, y + 1]) pts.push({ x: b.left + x * sx, y: b.top + yy * sy });
    }
  }
  return { pts, area: kept.reduce((n, v) => n + v, 0) * sx * sy };
}

// The mask's area in frame pixels.
export function maskPixels(o: SamObject): number {
  const b = o.bounds;
  return (maskArea(o) * (b.right - b.left) * (b.bottom - b.top)) / (o.mask.width * o.mask.height);
}

// The mask as a tinted image the size of its raster, for drawImage into bounds.
export function maskImage(o: SamObject, rgba: [number, number, number, number]): HTMLCanvasElement {
  const { width, height, data } = o.mask;
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const g = c.getContext("2d")!;
  const img = g.createImageData(width, height);
  data.forEach((v, i) => {
    if (v) img.data.set(rgba, i * 4);
  });
  g.putImageData(img, 0, 0);
  return c;
}
