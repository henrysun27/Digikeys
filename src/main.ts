import "./style.css";
import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from "@mediapipe/tasks-vision";
import { Calibration, CORNER_NAMES } from "./calibration.ts";
import { CONFIG } from "./config.ts";
import { applyH, type Pt } from "./geometry.ts";
import { PIANO_LAYOUT, hitTest, shapeCenter, shapeOutline, type Layout, type Zone } from "./layout.ts";

const FINGERTIPS = [4, 8, 12, 16, 20];

const video = document.querySelector<HTMLVideoElement>("#video")!;
const canvas = document.querySelector<HTMLCanvasElement>("#view")!;
const statusEl = document.querySelector<HTMLDivElement>("#status")!;
const hintEl = document.querySelector<HTMLDivElement>("#hint")!;
const resetBtn = document.querySelector<HTMLButtonElement>("#reset")!;
const ctx = canvas.getContext("2d")!;

const calibration = new Calibration();
const layout: Layout = PIANO_LAYOUT;
let hintError: string | null = null;

// Coordinate spaces:
//   cam    - raw camera coords normalized to 0-1, unmirrored (same as MediaPipe landmarks)
//   board  - 0-1 over the calibrated playing surface
//   screen - canvas pixels in the mirrored view
function camToScreen(p: Pt): Pt {
  return { x: (1 - p.x) * canvas.width, y: p.y * canvas.height };
}

function screenToCam(p: Pt): Pt {
  return { x: 1 - p.x / canvas.width, y: p.y / canvas.height };
}

function boardToScreen(p: Pt): Pt {
  return camToScreen(applyH(calibration.boardToCam!, p));
}

function setStatus(text: string) {
  statusEl.textContent = text;
}

function updateHint() {
  canvas.classList.toggle("calibrating", !calibration.done);
  hintEl.classList.toggle("error", hintError !== null);
  if (calibration.done) {
    hintEl.textContent = "Calibrated. Press Reset corners to redo.";
    return;
  }
  const n = calibration.corners.length;
  const next = `Click corner ${n + 1} of 4: ${CORNER_NAMES[n]} of the playing surface.`;
  hintEl.textContent = hintError ? `${hintError}. ${next}` : next;
}

canvas.addEventListener("click", (e) => {
  if (calibration.done || video.videoWidth === 0) return;
  const rect = canvas.getBoundingClientRect();
  const screen = {
    x: ((e.clientX - rect.left) * canvas.width) / rect.width,
    y: ((e.clientY - rect.top) * canvas.height) / rect.height,
  };
  hintError = calibration.add(screenToCam(screen));
  updateHint();
});

resetBtn.addEventListener("click", () => {
  calibration.reset();
  hintError = null;
  updateHint();
});

async function startCamera() {
  const { width, height, frameRate } = CONFIG.camera;
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: frameRate } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
}

async function createLandmarker() {
  const h = CONFIG.hands;
  const fileset = await FilesetResolver.forVisionTasks(h.wasmPath);
  return HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: h.modelPath, delegate: "GPU" },
    runningMode: "VIDEO",
    numHands: h.numHands,
    minHandDetectionConfidence: h.minHandDetectionConfidence,
    minHandPresenceConfidence: h.minHandPresenceConfidence,
    minTrackingConfidence: h.minTrackingConfidence,
  });
}

function zonesUnderFingertips(result: HandLandmarkerResult | null): Set<string> {
  const hits = new Set<string>();
  if (!result || !calibration.camToBoard) return hits;
  for (const hand of result.landmarks) {
    for (const i of FINGERTIPS) {
      const zone = hitTest(layout, applyH(calibration.camToBoard, hand[i]));
      if (zone) hits.add(zone.id);
    }
  }
  return hits;
}

function tracePath(pts: Pt[], close: boolean) {
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  if (close) ctx.closePath();
}

function drawLayout(active: Set<string>) {
  if (!calibration.done) return;
  for (const zone of layout.zones) {
    const outline = shapeOutline(zone.shape).map(boardToScreen);
    tracePath(outline, true);
    ctx.fillStyle = active.has(zone.id) ? "rgba(255, 196, 0, 0.55)" : "rgba(255, 255, 255, 0.12)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.lineWidth = 2;
    ctx.stroke();
    drawLabel(zone, outline);
  }
}

// Text stays upright in screen space, sized to the key's on-screen footprint.
function drawLabel(zone: Zone, outline: Pt[]) {
  const c = boardToScreen(shapeCenter(zone.shape));
  const xs = outline.map((p) => p.x);
  const ys = outline.map((p) => p.y);
  const extent = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const size = Math.max(10, Math.min(32, extent * 0.4));
  ctx.font = `600 ${size}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
  ctx.strokeText(zone.label, c.x, c.y);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(zone.label, c.x, c.y);
}

function drawCorners() {
  const pts = calibration.corners.map(camToScreen);
  if (pts.length === 0) return;
  ctx.setLineDash([8, 6]);
  ctx.strokeStyle = "#ffd400";
  ctx.lineWidth = 2;
  tracePath(pts, calibration.done);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = "700 14px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  pts.forEach((p, i) => {
    ctx.fillStyle = "#ffd400";
    ctx.beginPath();
    ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#000000";
    ctx.fillText(String(i + 1), p.x, p.y);
  });
}

function drawHands(result: HandLandmarkerResult) {
  for (const hand of result.landmarks) {
    const pts = hand.map(camToScreen);
    ctx.strokeStyle = "rgba(0, 255, 180, 0.8)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (const { start, end } of HandLandmarker.HAND_CONNECTIONS) {
      ctx.moveTo(pts[start].x, pts[start].y);
      ctx.lineTo(pts[end].x, pts[end].y);
    }
    ctx.stroke();

    pts.forEach((p, i) => {
      const tip = FINGERTIPS.includes(i);
      ctx.fillStyle = tip ? "#ff3b6b" : "#ffffff";
      ctx.beginPath();
      ctx.arc(p.x, p.y, tip ? 7 : 4, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}

function loop(landmarker: HandLandmarker) {
  let lastVideoTime = -1;
  let result: HandLandmarkerResult | null = null;
  let frames = 0;
  let fpsStart = performance.now();

  const tick = () => {
    const now = performance.now();
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      result = landmarker.detectForVideo(video, now);
      frames++;
    }

    // Only the video is drawn through a mirror transform; overlays use screen coords so
    // text stays readable.
    ctx.setTransform(-1, 0, 0, 1, canvas.width, 0);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawLayout(zonesUnderFingertips(result));
    drawCorners();
    if (result) drawHands(result);

    if (now - fpsStart >= 1000) {
      const fps = (frames * 1000) / (now - fpsStart);
      setStatus(`${result?.landmarks.length ?? 0} hand(s) · ${fps.toFixed(0)} fps`);
      frames = 0;
      fpsStart = now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function main() {
  calibration.load();
  try {
    setStatus("Starting camera…");
    await startCamera();
    updateHint();
    setStatus("Loading hand model…");
    const landmarker = await createLandmarker();
    setStatus("Running");
    loop(landmarker);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

main();
