// Copies the MediaPipe wasm runtime and downloads the hand landmarker model into
// public/mediapipe so both are served from our own origin. Output is gitignored.
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasmSrc = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const outDir = join(root, "public", "mediapipe");
const wasmOut = join(outDir, "wasm");
const modelOut = join(outDir, "hand_landmarker.task");
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

mkdirSync(wasmOut, { recursive: true });

for (const name of readdirSync(wasmSrc)) {
  const src = join(wasmSrc, name);
  const dst = join(wasmOut, name);
  if (existsSync(dst) && statSync(dst).size === statSync(src).size) continue;
  copyFileSync(src, dst);
  console.log(`[mediapipe] copied wasm/${name}`);
}

if (!existsSync(modelOut)) {
  console.log(`[mediapipe] downloading ${MODEL_URL}`);
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model download failed: ${res.status} ${res.statusText}`);
  const tmp = `${modelOut}.part`;
  writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  renameSync(tmp, modelOut);
  console.log(`[mediapipe] saved hand_landmarker.task`);
}
