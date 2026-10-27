import "./style.css";
import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from "@mediapipe/tasks-vision";
import { Calibration, CORNER_NAMES, checkCorners, orderCorners } from "./calibration.ts";
import { CONFIG } from "./config.ts";
import { logIgnored, logPlayed, resolveTap, showLevel, showMicInfo } from "./debug.ts";
import { applyH, convexHull, fitQuad, polygonArea, type Pt } from "./geometry.ts";
import { PRESETS, hitTest, shapeCenter, shapeOutline, type Layout, type Zone } from "./layout.ts";
import { startMic, type Onset } from "./mic.ts";
import { maskArea, maskImage, maskOutline, maskPixels, segmentFrame, type SamObject, type Segmentation } from "./sam.ts";
import { initSound, play } from "./sound.ts";
import { FINGER_NAMES, FINGERTIPS, FingerHistory } from "./taps.ts";

const video = document.querySelector<HTMLVideoElement>("#video")!;
const canvas = document.querySelector<HTMLCanvasElement>("#view")!;
const statusEl = document.querySelector<HTMLDivElement>("#status")!;
const hintEl = document.querySelector<HTMLDivElement>("#hint")!;
const resetBtn = document.querySelector<HTMLButtonElement>("#reset")!;
const micBtn = document.querySelector<HTMLButtonElement>("#mic")!;
const layoutSelect = document.querySelector<HTMLSelectElement>("#layout")!;
const detectBtn = document.querySelector<HTMLButtonElement>("#detect")!;
const samStatusEl = document.querySelector<HTMLDivElement>("#sam-status")!;
const samActions = document.querySelector<HTMLDivElement>("#sam-actions")!;
const acceptBtn = document.querySelector<HTMLButtonElement>("#accept")!;
const retryBtn = document.querySelector<HTMLButtonElement>("#retry")!;
const discardBtn = document.querySelector<HTMLButtonElement>("#discard")!;
const ctx = canvas.getContext("2d")!;

const calibration = new Calibration();
let layout: Layout = PRESETS[0];
const history = new FingerHistory();
const flashes = new Map<string, number>(); // zone id -> flash end, performance.now() ms
let hintError: string | null = null;
let tapCount = 0;
let handsInFrame = 0; // hands in the latest detection
// A SAM 3.1 surface detection waiting for Accept. The largest match is taken as the playing
// surface; corners (raw cam coords, click order) are null if no quad could be fitted.
type Proposal = {
  seg: Segmentation;
  pick: SamObject;
  image: HTMLCanvasElement;
  corners: Pt[] | null;
  problem: string | null;
};
let proposal: Proposal | null = null;

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
  const or = n === 0 ? ", or press Detect surface" : "";
  const next = `Click corner ${n + 1} of 4: ${CORNER_NAMES[n]} of the playing surface${or}.`;
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
  setProposal(null);
  samStatusEl.textContent = "";
  hintError = null;
  updateHint();
});

PRESETS.forEach((preset, i) => layoutSelect.add(new Option(preset.instrument, String(i))));
layoutSelect.addEventListener("change", () => {
  layout = PRESETS[Number(layoutSelect.value)];
  flashes.clear();
});

// Playing-surface corners from a SAM mask: convex hull, then the enclosing quad, in click
// order. fit is quad area / mask area (1 = the mask is exactly a quadrilateral).
function fitSurface(seg: Segmentation, pick: SamObject): { corners: Pt[]; fit: number } | null {
  const { pts, area } = maskOutline(pick);
  const quad = fitQuad(convexHull(pts));
  if (!quad) return null;
  const norm = quad.map((p) => ({ x: p.x / seg.width, y: p.y / seg.height }));
  return {
    corners: orderCorners(norm, seg.width / seg.height),
    fit: Math.abs(polygonArea(quad)) / area,
  };
}

function setProposal(p: Proposal | null) {
  proposal = p;
  samActions.hidden = p === null;
  acceptBtn.disabled = !p?.corners || p.problem !== null;
}

function setDetecting(busy: boolean) {
  detectBtn.disabled = busy;
  retryBtn.disabled = busy;
  if (busy) acceptBtn.disabled = true;
  else setProposal(proposal);
}

async function detectSurface() {
  if (video.videoWidth === 0) return;
  const { boundaryPrompt: prompt, minSurfaceFrac, looseFitRatio } = CONFIG.sam;
  setDetecting(true);
  samStatusEl.textContent = `Asking SAM 3.1 for "${prompt}"…`;
  try {
    const seg = await segmentFrame(video, prompt);
    const found = `${seg.objects.length} match(es) for "${prompt}" in ${seg.ms.toFixed(0)} ms (SAM ${seg.serverMs} ms)`;
    const pick = seg.objects.reduce<SamObject | null>((a, o) => (!a || maskArea(o) > maskArea(a) ? o : a), null);
    if (!pick) {
      setProposal(null);
      samStatusEl.textContent = `SAM 3.1: ${found}. Retry, or click the corners.`;
      return;
    }
    const frac = maskPixels(pick) / (seg.width * seg.height);
    const fitted = fitSurface(seg, pick);
    const problem =
      frac < minSurfaceFrac
        ? `it covers only ${(frac * 100).toFixed(1)}% of the frame`
        : !fitted
          ? "couldn't fit 4 corners to it"
          : checkCorners(fitted.corners);
    setProposal({ seg, pick, image: maskImage(pick, [0, 200, 255, 90]), corners: fitted?.corners ?? null, problem });
    const conf = pick.confidence?.toFixed(2) ?? "?";
    const fit = fitted ? `, quad/mask area ${fitted.fit.toFixed(2)}` : "";
    const loose =
      fitted && fitted.fit > looseFitRatio
        ? " (loose fit: something covers part of the surface, or it isn't four-sided)"
        : "";
    samStatusEl.textContent = problem
      ? `SAM 3.1: ${found}. Largest (confidence ${conf}): ${problem}. Retry, or click the corners.`
      : `SAM 3.1: ${found}. Largest (confidence ${conf})${fit}${loose}. Accept to use these corners.`;
  } catch (err) {
    console.error(err);
    samStatusEl.textContent = `SAM 3.1 failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    setDetecting(false);
  }
}

detectBtn.addEventListener("click", detectSurface);
retryBtn.addEventListener("click", detectSurface);
discardBtn.addEventListener("click", () => {
  setProposal(null);
  samStatusEl.textContent = "";
});
acceptBtn.addEventListener("click", () => {
  if (!proposal?.corners) return;
  const problem = calibration.set(proposal.corners);
  if (problem) {
    samStatusEl.textContent = `Can't use these corners: ${problem}. Retry, or click the corners.`;
    return;
  }
  setProposal(null);
  samStatusEl.textContent = "Using the corners from SAM 3.1.";
  hintError = null;
  updateHint();
});

// One AudioContext, created inside the click, for both the mic detector and Tone. Sounds
// load and warm up here so the first tap isn't silent.
micBtn.addEventListener("click", async () => {
  micBtn.disabled = true;
  micBtn.textContent = "Starting mic, loading sounds…";
  try {
    const audioCtx = new AudioContext({ latencyHint: "interactive" });
    await audioCtx.resume();
    await Promise.all([
      startMic(audioCtx, { onOnset, onLevel: showLevel, onInfo: showMicInfo }),
      initSound(audioCtx),
    ]);
    micBtn.textContent = "Mic on";
  } catch (err) {
    console.error(err);
    micBtn.disabled = false;
    micBtn.textContent = `Enable mic (${err instanceof Error ? err.message : String(err)})`;
  }
});

function zoneAt(p: Pt): Zone | null {
  return calibration.camToBoard ? hitTest(layout, applyH(calibration.camToBoard, p)) : null;
}

// Plays right away from the best-guess finger. The finger frames for the moment of the
// onset arrive videoLagMs later and the stop may be up to stopToleranceMs after that, so
// the tap is checked against the stopped finger once those frames are in.
function onOnset(onset: Onset) {
  const n = ++tapCount;
  if (handsInFrame === 0) {
    logIgnored(n, "no hand");
    return;
  }
  const { videoLagMs, stopToleranceMs, settleMarginMs, flashMs } = CONFIG.taps;
  const guess = history.guess(onset.time);
  const zone = guess ? zoneAt(guess.at) : null;
  const latencyMs = zone ? play(zone.sound, onset.ctxTime) : null;
  if (zone) flashes.set(zone.id, performance.now() + flashMs);
  const line = logPlayed({ n, finger: guess?.finger ?? null, zone: zone?.label ?? null, latencyMs });

  const resolveAt = onset.time + videoLagMs + stopToleranceMs + settleMarginMs;
  setTimeout(() => {
    const pick = history.resolve(onset.time);
    resolveTap(line, guess?.finger ?? null, {
      finger: pick?.finger ?? null,
      zone: pick ? (zoneAt(pick.at)?.label ?? null) : null,
      stopOffset: pick?.stopOffset ?? null,
    });
  }, Math.max(0, resolveAt - performance.now()));
}

// Handedness labels come straight from MediaPipe; they only need to be stable per hand.
function recordFingers(result: HandLandmarkerResult, detectedAt: number) {
  result.landmarks.forEach((hand, h) => {
    const side = result.handedness[h]?.[0]?.categoryName ?? `Hand ${h + 1}`;
    FINGERTIPS.forEach((tip, f) => {
      history.add(`${side} ${FINGER_NAMES[f]}`, { t: detectedAt, x: hand[tip].x, y: hand[tip].y });
    });
  });
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

function drawLayout(active: Set<string>, now: number) {
  if (!calibration.done) return;
  for (const zone of layout.zones) {
    const outline = shapeOutline(zone.shape).map(boardToScreen);
    tracePath(outline, true);
    ctx.fillStyle = active.has(zone.id) ? "rgba(255, 196, 0, 0.55)" : "rgba(255, 255, 255, 0.12)";
    ctx.fill();
    const flashLeft = (flashes.get(zone.id) ?? 0) - now;
    if (flashLeft > 0) {
      ctx.fillStyle = `rgba(0, 220, 255, ${(0.85 * flashLeft) / CONFIG.taps.flashMs})`;
      ctx.fill();
    }
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

// The pending detection: the mask, drawn in camera pixels through the mirror transform like
// the video, and its fitted corners.
function drawProposal() {
  if (!proposal) return;
  const { seg, pick, image, corners } = proposal;
  const s = canvas.width / seg.width;
  const b = pick.bounds;
  ctx.setTransform(-s, 0, 0, s, canvas.width, 0);
  ctx.drawImage(image, b.left, b.top, b.right - b.left, b.bottom - b.top);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (corners) drawCorners(corners, true, "#00dcff");
}

// Numbered corner dots joined by a dashed outline; corners in cam coords.
function drawCorners(corners: Pt[], closed: boolean, color: string) {
  const pts = corners.map(camToScreen);
  if (pts.length === 0) return;
  ctx.setLineDash([8, 6]);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  tracePath(pts, closed);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = "700 14px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  pts.forEach((p, i) => {
    ctx.fillStyle = color;
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
      recordFingers(result, now);
      handsInFrame = result.landmarks.length;
      frames++;
    }

    // Only the video is drawn through a mirror transform; overlays use screen coords so
    // text stays readable.
    ctx.setTransform(-1, 0, 0, 1, canvas.width, 0);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawLayout(zonesUnderFingertips(result), now);
    drawCorners(calibration.corners, calibration.done, "#ffd400");
    drawProposal();
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
