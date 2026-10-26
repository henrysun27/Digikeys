import "./style.css";
import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from "@mediapipe/tasks-vision";
import { CONFIG } from "./config.ts";

const FINGERTIPS = [4, 8, 12, 16, 20];

const video = document.querySelector<HTMLVideoElement>("#video")!;
const canvas = document.querySelector<HTMLCanvasElement>("#view")!;
const statusEl = document.querySelector<HTMLDivElement>("#status")!;
const ctx = canvas.getContext("2d")!;

function setStatus(text: string) {
  statusEl.textContent = text;
}

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

// Landmarks are in raw camera coordinates; the canvas transform does the mirroring.
function drawHands(result: HandLandmarkerResult) {
  const w = canvas.width;
  const h = canvas.height;
  for (const hand of result.landmarks) {
    ctx.strokeStyle = "rgba(0, 255, 180, 0.8)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (const { start, end } of HandLandmarker.HAND_CONNECTIONS) {
      ctx.moveTo(hand[start].x * w, hand[start].y * h);
      ctx.lineTo(hand[end].x * w, hand[end].y * h);
    }
    ctx.stroke();

    hand.forEach((p, i) => {
      const tip = FINGERTIPS.includes(i);
      ctx.fillStyle = tip ? "#ff3b6b" : "#ffffff";
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, tip ? 7 : 4, 0, Math.PI * 2);
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

    ctx.setTransform(-1, 0, 0, 1, canvas.width, 0);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (result) drawHands(result);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

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
  try {
    setStatus("Starting camera…");
    await startCamera();
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
