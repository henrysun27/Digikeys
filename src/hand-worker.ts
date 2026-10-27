// Runs HandLandmarker off the main thread, so mic onsets never wait behind detection.
// Frames arrive as transferred ImageBitmaps; landmarks go back with the frame's timestamp.
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import { CONFIG } from "./config.ts";

export type HandFrame = {
  landmarks: { x: number; y: number; z: number }[][];
  handedness: { categoryName: string }[][];
};
export type ToWorker = { type: "frame"; bitmap: ImageBitmap; t: number };
// delegate: what HandLandmarker runs on; gpuError: why GPU failed if it fell back to CPU.
// renderer: the worker's WebGL renderer ("SwiftShader" means software, not the GPU).
export type WorkerInfo = { delegate: "GPU" | "CPU"; gpuError: string | null; renderer: string };
export type FromWorker =
  | ({ type: "ready" } & WorkerInfo)
  | { type: "error"; message: string }
  | { type: "result"; t: number; frame: HandFrame; detectMs: number };

const post = (m: FromWorker) => postMessage(m);
let landmarker: HandLandmarker | null = null;
let lastT = -Infinity;

function webglRenderer(): string {
  const gl = new OffscreenCanvas(1, 1).getContext("webgl2");
  if (!gl) return "no WebGL2 in worker";
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
}

async function init() {
  const h = CONFIG.hands;
  // useModule: this is a module worker, which can't importScripts the classic loader.
  // MediaPipe then import()s the loader; an absolute URL keeps Vite's dev server from
  // adding "?import" to it, which it refuses for files in public/.
  const fileset = await FilesetResolver.forVisionTasks(new URL(h.wasmPath, location.href).href, true);
  const create = (delegate: "GPU" | "CPU") =>
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: h.modelPath, delegate },
      runningMode: "VIDEO",
      numHands: h.numHands,
      minHandDetectionConfidence: h.minHandDetectionConfidence,
      minHandPresenceConfidence: h.minHandPresenceConfidence,
      minTrackingConfidence: h.minTrackingConfidence,
    });
  let delegate: "GPU" | "CPU" = "GPU";
  let gpuError: string | null = null;
  try {
    landmarker = await create("GPU");
  } catch (err) {
    gpuError = err instanceof Error ? err.message : String(err);
    delegate = "CPU";
    landmarker = await create("CPU");
  }
  post({ type: "ready", delegate, gpuError, renderer: webglRenderer() });
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
