// Runs HandLandmarker off the main thread, so mic onsets never wait behind detection.
// Frames arrive as transferred ImageBitmaps; landmarks go back with the frame's timestamp.
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import { CONFIG } from "./config.ts";

export type HandFrame = {
  landmarks: { x: number; y: number; z: number }[][];
  handedness: { categoryName: string }[][];
};
export type ToWorker = { type: "frame"; bitmap: ImageBitmap; t: number };
export type FromWorker =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "result"; t: number; frame: HandFrame; detectMs: number };

const post = (m: FromWorker) => postMessage(m);
let landmarker: HandLandmarker | null = null;
let lastT = -Infinity;

async function init() {
  const h = CONFIG.hands;
  // useModule: this is a module worker, which can't importScripts the classic loader.
  // MediaPipe then import()s the loader; an absolute URL keeps Vite's dev server from
  // adding "?import" to it, which it refuses for files in public/.
  const fileset = await FilesetResolver.forVisionTasks(new URL(h.wasmPath, location.href).href, true);
  landmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: h.modelPath, delegate: "GPU" },
    runningMode: "VIDEO",
    numHands: h.numHands,
    minHandDetectionConfidence: h.minHandDetectionConfidence,
    minHandPresenceConfidence: h.minHandPresenceConfidence,
    minTrackingConfidence: h.minTrackingConfidence,
  });
  post({ type: "ready" });
}

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
  post({
    type: "result",
    t,
    frame: {
      landmarks: r.landmarks.map((hand) => hand.map(({ x, y, z }) => ({ x, y, z }))),
      handedness: r.handedness.map((cats) => cats.map(({ categoryName }) => ({ categoryName }))),
    },
    detectMs: performance.now() - start,
  });
};

init().catch((err) => post({ type: "error", message: err instanceof Error ? err.message : String(err) }));
