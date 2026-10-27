import { CONFIG } from "./config.ts";

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

// The current video frame, unmirrored, at full camera resolution.
function captureFrame(video: HTMLVideoElement): { image: string; width: number; height: number } {
  const c = document.createElement("canvas");
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext("2d")!.drawImage(video, 0, 0);
  return { image: c.toDataURL("image/jpeg", CONFIG.sam.jpegQuality), width: c.width, height: c.height };
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
  const objects = (body.objects as WireObject[]).map((o) => ({
    ...o,
    mask: {
      width: o.mask.width,
      height: o.mask.height,
      data: unpackBits(o.mask.bits, o.mask.width * o.mask.height),
    },
  }));
  return { prompt, width, height, objects, ms: performance.now() - started, serverMs: body.ms };
}

export function maskArea(o: SamObject): number {
  return o.mask.data.reduce((n, v) => n + v, 0);
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
