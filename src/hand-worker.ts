// Runs HandLandmarker off the main thread, so mic onsets never wait behind detection.
// Frames arrive as transferred ImageBitmaps; landmarks go back with the frame's timestamp,
// and with shadow readings from the same bitmap when the frame asks for them.
import type { HandLandmarker } from "@mediapipe/tasks-vision";
import { createHandLandmarker, toHandFrame, type DetectorInfo, type HandFrame } from "./hand-detector.ts";
import { sampleShadows, type ShadowRequest, type ShadowResult } from "./shadow.ts";

export type ToWorker = { type: "frame"; bitmap: ImageBitmap; t: number; shadow: ShadowRequest | null };
export type FromWorker =
  | ({ type: "ready" } & DetectorInfo)
  | { type: "error"; message: string }
  | { type: "result"; t: number; frame: HandFrame; detectMs: number; shadow: ShadowResult | null };

const post = (m: FromWorker) => postMessage(m);
let landmarker: HandLandmarker | null = null;
let lastT = -Infinity;

onmessage = (e: MessageEvent<ToWorker>) => {
  const { bitmap, t, shadow } = e.data;
  if (!landmarker) {
    bitmap.close();
    return;
  }
  // VIDEO mode needs strictly increasing timestamps.
  const ts = Math.max(t, lastT + 0.001);
  lastT = ts;
  const start = performance.now();
  const frame = toHandFrame(landmarker.detectForVideo(bitmap, ts));
  const detectMs = performance.now() - start;
  const shadows = shadow ? sampleShadows(bitmap, bitmap.width, bitmap.height, frame, shadow) : null;
  bitmap.close();
  post({ type: "result", t, frame, detectMs, shadow: shadows });
};

createHandLandmarker().then(
  (d) => {
    landmarker = d.landmarker;
    post({ type: "ready", ...d.info });
  },
  (err) => post({ type: "error", message: err instanceof Error ? err.message : String(err) }),
);
