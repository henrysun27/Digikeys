// Creates the HandLandmarker, for the worker or the main thread alike.
import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from "@mediapipe/tasks-vision";
import { CONFIG } from "./config.ts";

export type HandFrame = {
  landmarks: { x: number; y: number; z: number }[][];
  handedness: { categoryName: string }[][];
};
// delegate: what HandLandmarker runs on; gpuError: why GPU failed if it fell back to CPU.
// renderer: the WebGL renderer it got ("SwiftShader" means software, not the GPU).
export type DetectorInfo = { delegate: "GPU" | "CPU"; gpuError: string | null; renderer: string };

// useModule: the worker is a module worker, which can't importScripts the classic loader,
// so there MediaPipe import()s the ES module one. On the main thread it adds a classic
// <script>, which needs the classic loader. An absolute URL keeps Vite's dev server from
// adding "?import" to the worker's import(), which it refuses for files in public/.
//
// The WebGL2 context is created here first, asking for the high-performance GPU, and the
// canvas handed to MediaPipe: its own getContext call then gets this same context.
export async function createHandLandmarker(): Promise<{ landmarker: HandLandmarker; info: DetectorInfo }> {
  const h = CONFIG.hands;
  const inWorker = typeof document === "undefined";
  const fileset = await FilesetResolver.forVisionTasks(new URL(h.wasmPath, location.href).href, inWorker);
  const canvas = new OffscreenCanvas(1, 1);
  const gl = canvas.getContext("webgl2", { powerPreference: h.powerPreference });
  const create = (delegate: "GPU" | "CPU") =>
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: h.modelPath, delegate },
      canvas,
      runningMode: "VIDEO",
      numHands: h.numHands,
      minHandDetectionConfidence: h.minHandDetectionConfidence,
      minHandPresenceConfidence: h.minHandPresenceConfidence,
      minTrackingConfidence: h.minTrackingConfidence,
    });
  let landmarker: HandLandmarker;
  let delegate: "GPU" | "CPU" = "GPU";
  let gpuError: string | null = null;
  try {
    landmarker = await create("GPU");
  } catch (err) {
    gpuError = err instanceof Error ? err.message : String(err);
    delegate = "CPU";
    landmarker = await create("CPU");
  }
  let renderer = "no WebGL2";
  if (gl) {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    renderer = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  }
  return { landmarker, info: { delegate, gpuError, renderer } };
}

// Plain data, so it can be posted from the worker.
export function toHandFrame(r: HandLandmarkerResult): HandFrame {
  return {
    landmarks: r.landmarks.map((hand) => hand.map(({ x, y, z }) => ({ x, y, z }))),
    handedness: r.handedness.map((cats) => cats.map(({ categoryName }) => ({ categoryName }))),
  };
}
