import { CONFIG } from "./config.ts";
import type { Pt } from "./geometry.ts";
import type { Orientation } from "./orientation.ts";

export type LayoutReply = {
  aspect: unknown; // the model's board width / depth; unchecked
  spec: unknown; // an InstrumentSpec as the model gave it; unchecked
  usage: { completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } | null;
  model: string;
  ms: number; // round trip as seen by the browser
  serverMs: number;
};

// The current frame as the player sees it (mirrored), with the board outlined and its
// corners numbered, and the corners in that image's pixels. corners are cam coords in
// click order, so corner 1 is board (0,0).
function captureBoardFrame(video: HTMLVideoElement, corners: Pt[]) {
  const c = document.createElement("canvas");
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  const g = c.getContext("2d")!;
  g.setTransform(-1, 0, 0, 1, c.width, 0);
  g.drawImage(video, 0, 0);
  g.setTransform(1, 0, 0, 1, 0, 0);
  const px = corners.map((p) => ({ x: (1 - p.x) * c.width, y: p.y * c.height }));

  const r = Math.max(8, c.height / 60);
  g.strokeStyle = g.fillStyle = "#ff00ff";
  g.lineWidth = Math.max(2, c.height / 300);
  g.beginPath();
  px.forEach((p, i) => (i === 0 ? g.moveTo(p.x, p.y) : g.lineTo(p.x, p.y)));
  g.closePath();
  g.stroke();
  g.font = `700 ${Math.round(r * 1.3)}px system-ui, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  px.forEach((p, i) => {
    g.fillStyle = "#ff00ff";
    g.beginPath();
    g.arc(p.x, p.y, r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#ffffff";
    g.fillText(String(i + 1), p.x, p.y);
  });
  return { image: c.toDataURL("image/jpeg", CONFIG.muse.jpegQuality), width: c.width, height: c.height, corners: px };
}

// Asks Muse Spark, through the server, what one object crop is and what it should sound
// like. description is unchecked (checkDescription in objects.ts).
export async function describeObjectCrop(image: string): Promise<{ description: unknown; ms: number; serverMs: number }> {
  const started = performance.now();
  const res = await fetch("/api/objects/describe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image }),
  });
  const body = await res.json().catch(() => ({ error: `server returned ${res.status}` }));
  if (!res.ok) throw new Error(body.error ?? `server returned ${res.status}`);
  return { description: body.description, ms: performance.now() - started, serverMs: body.ms };
}

// Asks Muse Spark, through the server, for an instrument spec for the request on this board,
// in the frame of a player sitting as `orientation` says.
export async function requestLayout(
  video: HTMLVideoElement,
  corners: Pt[],
  request: string,
  orientation: Orientation,
): Promise<LayoutReply> {
  const started = performance.now();
  const frame = captureBoardFrame(video, corners);
  const res = await fetch("/api/layout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...frame, request, orientation }),
  });
  const body = await res.json().catch(() => ({ error: `server returned ${res.status}` }));
  if (!res.ok) throw new Error(body.error ?? `server returned ${res.status}`);
  return { ...body, ms: performance.now() - started, serverMs: body.ms };
}
