// Runs HandLandmarker off the main thread, so mic onsets never wait behind detection.
// Frames arrive as transferred ImageBitmaps; landmarks go back with the frame's timestamp.
import type { HandLandmarker } from "@mediapipe/tasks-vision";
import { createHandLandmarker, toHandFrame, type DetectorInfo, type HandFrame } from "./hand-detector.ts";

export type ToWorker = { type: "frame"; bitmap: ImageBitmap; t: number };
export type FromWorker =
  | ({ type: "ready" } & DetectorInfo)
  | { type: "error"; message: string }
  | { type: "result"; t: number; frame: HandFrame; detectMs: number };

const post = (m: FromWorker) => postMessage(m);
let landmarker: HandLandmarker | null = null;
let lastT = -Infinity;

onmessage = (e: MessageEvent<ToWorker>) => {
  const { bitmap, t } = e.data;
  if (!landmarker) {
    bitmap.close();
    return;
  }
  // VIDEO mode needs strictly increasing timestamps.
  const ts = Math.max(t, lastT + 0.001);
  lastT = ts;
  const start = performance.now();
  const r = landmarker.detectForVideo(bitmap, ts);
  bitmap.close();
  post({ type: "result", t, frame: toHandFrame(r), detectMs: performance.now() - start });
};

createHandLandmarker().then(
  (d) => {
    landmarker = d.landmarker;
    post({ type: "ready", ...d.info });
  },
  (err) => post({ type: "error", message: err instanceof Error ? err.message : String(err) }),
);
