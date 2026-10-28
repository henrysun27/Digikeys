import "./style.css";
import { Calibration, CORNER_NAMES, checkCorners, orderCorners } from "./calibration.ts";
import { CONFIG } from "./config.ts";
import {
  logIgnored,
  logMissed,
  logPlayed,
  logRejected,
  logTest,
  logVisionTap,
  resolveTap,
  showCamera,
  showCorrections,
  showDetection,
  showProbe,
  showDropouts,
  showLevel,
  showMicInfo,
  showPlayer,
  showTest,
} from "./debug.ts";
import { applyH, convexHull, fitQuad, polygonArea, type Pt } from "./geometry.ts";
import { HAND_CONNECTIONS, HandTracking, type TrackedHand } from "./hand-tracking.ts";
import { createDetector, type Detector } from "./detectors.ts";
import type { HandFrame } from "./hand-detector.ts";
import { describeSpec, layoutFromSpec, PRESETS, presetFor } from "./instrument.ts";
import { hitTest, isAccidental, shapeOutline, zoneAnchor, zStack, type Layout, type Zone } from "./layout.ts";
import { startMic, type MicLevel, type Onset } from "./mic.ts";
import {
  leftEdge,
  orientLayout,
  PlayerEdgeDetector,
  screenSide,
  topEdge,
  type Orientation,
} from "./orientation.ts";
import { requestLayout } from "./muse.ts";
import { scanObjects } from "./object-scan.ts";
import { soundName } from "./objects.ts";
import { Recording, transcribe } from "./voice.ts";
import { maskArea, maskImage, maskOutline, maskPixels, segmentFrame, type SamObject, type Segmentation } from "./sam.ts";
import { initSound, playNow } from "./sound.ts";
import {
  FINGER_NAMES,
  FINGERTIPS,
  FingerHistory,
  fingerKey,
  handOf,
  landing,
  type FingerPick,
  stopWindow,
} from "./taps.ts";
import {
  applyCorrection,
  loadCorrections,
  saveCorrections,
  TapCalibration,
  type TapCorrections,
  type TapKind,
} from "./tap-correction.ts";
import { TestMode, type Attempt } from "./test-mode.ts";

const video = document.querySelector<HTMLVideoElement>("#video")!;
const canvas = document.querySelector<HTMLCanvasElement>("#view")!;
const statusEl = document.querySelector<HTMLDivElement>("#status")!;
const hintEl = document.querySelector<HTMLDivElement>("#hint")!;
const resetBtn = document.querySelector<HTMLButtonElement>("#reset")!;
const testBtn = document.querySelector<HTMLButtonElement>("#test")!;
const calTapsBtn = document.querySelector<HTMLButtonElement>("#cal-taps")!;
const clearCorrectionBtn = document.querySelector<HTMLButtonElement>("#clear-correction")!;
const resetStatsBtn = document.querySelector<HTMLButtonElement>("#reset-stats")!;
const probeBtn = document.querySelector<HTMLButtonElement>("#probe-camera")!;
const tapCalStatusEl = document.querySelector<HTMLDivElement>("#tap-cal-status")!;
const micBtn = document.querySelector<HTMLButtonElement>("#mic")!;
const tapModeSelect = document.querySelector<HTMLSelectElement>("#tap-mode")!;
const layoutSelect = document.querySelector<HTMLSelectElement>("#layout")!;
const fingersSelect = document.querySelector<HTMLSelectElement>("#fingers")!;
const detectBtn = document.querySelector<HTMLButtonElement>("#detect")!;
const samPromptInput = document.querySelector<HTMLInputElement>("#sam-prompt")!;
const samStatusEl = document.querySelector<HTMLDivElement>("#sam-status")!;
const samActions = document.querySelector<HTMLDivElement>("#sam-actions")!;
const acceptBtn = document.querySelector<HTMLButtonElement>("#accept")!;
const retryBtn = document.querySelector<HTMLButtonElement>("#retry")!;
const discardBtn = document.querySelector<HTMLButtonElement>("#discard")!;
const instrumentInput = document.querySelector<HTMLInputElement>("#instrument")!;
const generateBtn = document.querySelector<HTMLButtonElement>("#generate")!;
const talkBtn = document.querySelector<HTMLButtonElement>("#talk")!;
const layoutStatusEl = document.querySelector<HTMLDivElement>("#layout-status")!;
const scanObjectsBtn = document.querySelector<HTMLButtonElement>("#scan-objects")!;
const clearObjectsBtn = document.querySelector<HTMLButtonElement>("#clear-objects")!;
const objectStatusEl = document.querySelector<HTMLDivElement>("#object-status")!;
const ctx = canvas.getContext("2d")!;

const calibration = new Calibration();
// source: the chosen layout in the player's frame; layout: it placed on the board for where
// the player sits (orientation), which hit-testing, drawing and sound use.
let source: Layout = PRESETS[0];
let orientation: Orientation = { near: "1-2", left: "4-1" };
let layout: Layout = orientLayout(source, orientation);
const playerEdges = new PlayerEdgeDetector();
let generated: Layout | null = null; // the last layout from Muse Spark that passed the checks
// Object pads from the last "Scan objects": poly zones in board coords (they may lie off the
// board), all above every instrument zone. Empty until a scan; cleared with new corners.
let objects: Layout = { instrument: "objects", zones: [] };
let scanning = false;
let generating = false;
// Push-to-talk: the recording in progress, whether its transcript is pending, and when taps
// resume after it (performance.now() ms).
let talk: { rec: Recording; ticker: number; cutoff: number } | null = null;
let transcribing = false;
let tapsResumeAt = 0;
const history = new FingerHistory();
const flashes = new Map<string, number>(); // zone id -> flash end, performance.now() ms
const zonePlayedAt = new Map<string, number>(); // zone id -> last played, performance.now() ms
let hintError: string | null = null;
let tapCount = 0;
let handsInFrame = 0; // hands in the latest detection
const tracking = new HandTracking();
// Hands that vanished between frames, by board column of their last index tip, against
// frames with a hand in that column; off board (or no board) counted separately.
const dropouts = {
  lost: new Array<number>(CONFIG.hands.dropoutColumns).fill(0),
  frames: new Array<number>(CONFIG.hands.dropoutColumns).fill(0),
  offLost: 0,
  offFrames: 0,
};
let lastTap: { hand: string; t: number } | null = null; // onset time, performance.now() ms
const test = new TestMode();
let corrections: TapCorrections | null = loadCorrections();
let tapCal: TapCalibration | null = null;
// Board-coord tap positions for the last CONFIG.taps.dotTaps taps that had a target.
type TapDot = { p: Pt; hit: boolean };
const dots: { guess: TapDot | null; check: TapDot | null }[] = [];
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
// Audio: one context for the mic detector and Tone, started by the mic button.
const audio = { ctx: null as AudioContext | null, micOn: false, soundOn: false, starting: false };
// Recent onset times (performance.now() ms) and mic level reports, for missed-tap checks.
const acceptedOnsets: number[] = [];
const rejectedOnsets: number[] = [];
const levels: MicLevel[] = [];

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

// Called whenever calibration changes. Test mode and tap calibration need a board to put
// targets on.
function updateHint() {
  syncOrientation();
  canvas.classList.toggle("calibrating", !calibration.done);
  testBtn.disabled = !calibration.done;
  generateBtn.disabled = !calibration.done || generating;
  talkBtn.disabled = !calibration.done || generating || transcribing;
  calTapsBtn.disabled = !calibration.done;
  scanObjectsBtn.disabled = !calibration.done || scanning;
  if (!calibration.done && test.active) setTesting(false);
  if (!calibration.done && tapCal) setTapCal(false);
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
  forgetPlayerEdge();
  clearObjects();
  setCorrections(null);
  setProposal(null);
  samStatusEl.textContent = "";
  hintError = null;
  updateHint();
});

// The picker lists the presets, plus the last generated layout once there is one.
PRESETS.forEach((preset, i) => layoutSelect.add(new Option(preset.instrument, String(i))));
const generatedOption = new Option("", "generated");
layoutSelect.addEventListener("change", () => {
  setLayout(layoutSelect.value === "generated" ? generated! : PRESETS[Number(layoutSelect.value)]);
});

function setLayout(l: Layout) {
  if (!PRESETS.includes(l)) {
    generated = l;
    generatedOption.text = `${l.instrument} (Muse Spark)`;
    if (!generatedOption.parentElement) layoutSelect.add(generatedOption);
  }
  layoutSelect.value = PRESETS.includes(l) ? String(PRESETS.indexOf(l)) : "generated";
  source = l;
  flashes.clear();
  placeLayout();
}

// Places the source layout on the board for the current orientation. Targets and tap
// calibration refer to zones of the old placement, so they start over.
function placeLayout() {
  layout = orientLayout(source, orientation);
  if (tapCal) setTapCal(false);
  if (test.active) {
    test.next(layout);
    updateTest();
  }
}

// Where the player sits: CONFIG.playerEdge once the hands have shown it, else the edge
// nearest the top of the camera image. Their left follows from the board's mapping.
// Re-places the layout when that changes. Called on calibration changes and hand results.
function syncOrientation() {
  const H = calibration.boardToCam;
  const near = H ? (CONFIG.playerEdge ?? topEdge(H)) : "1-2";
  const left = H ? leftEdge(near, H) : "4-1";
  if (near === orientation.near && left === orientation.left) return;
  orientation = { near, left };
  placeLayout();
  updatePlayerPanel();
}

function updatePlayerPanel() {
  const H = calibration.boardToCam;
  const { count, agreement } = playerEdges.estimate();
  showPlayer({
    ...orientation,
    board: H !== null,
    detected: CONFIG.playerEdge !== null,
    nearSide: H ? screenSide(orientation.near, H) : null,
    leftSide: H ? screenSide(orientation.left, H) : null,
    samples: count,
    agreement,
  });
}

// New corners make the detected edge meaningless: it names an edge of the old board.
function forgetPlayerEdge() {
  CONFIG.playerEdge = null;
  playerEdges.reset();
}

// Each hand over the board votes for the edge its wrist points at; the window's verdict is
// stored in CONFIG.playerEdge (kept when the window is undecided).
function trackPlayerEdge(hands: TrackedHand[], t: number) {
  if (!calibration.camToBoard) return;
  for (const { raw } of hands) {
    const wrist = toBoard(raw[0]);
    const tips = [8, 12, 16, 20].map((i) => toBoard(raw[i]));
    if (wrist && tips.every((p) => p)) playerEdges.add(t, wrist, tips as Pt[]);
  }
  const { edge } = playerEdges.estimate();
  if (edge) CONFIG.playerEdge = edge;
  syncOrientation();
}

// Muse Spark gets the request, the current frame and the accepted corners, and answers with
// the board's estimated aspect and an InstrumentSpec, which the layout engine builds.
// Anything unusable falls back to the preset matching the request, with the reason in the
// layout status line, after `heard` (the voice transcript and its timings, when the request
// was spoken). The status line shows the spec, the model's notes and any narrow-zone warning.
async function generateLayout(heard = "") {
  if (!calibration.done || video.videoWidth === 0 || generating) return;
  const request = instrumentInput.value.trim() || CONFIG.muse.defaultRequest;
  const fallback = (why: string) => {
    const preset = presetFor(request);
    setLayout(preset);
    layoutStatusEl.textContent = `${heard}Muse Spark layout not used: ${why}. Using the ${preset.instrument} preset.`;
  };
  generating = true;
  updateHint();
  layoutStatusEl.textContent = `${heard}Asking Muse Spark for "${request}"…`;
  try {
    const reply = await requestLayout(video, calibration.corners, request, orientation);
    const reasoning = reply.usage?.completion_tokens_details?.reasoning_tokens;
    const tokens = reply.usage?.completion_tokens;
    const took =
      `${(reply.ms / 1000).toFixed(1)} s` +
      (tokens !== undefined ? `, ${tokens} tokens${reasoning !== undefined ? ` (${reasoning} reasoning)` : ""}` : "");
    const [lo, hi] = CONFIG.layoutLimits.aspectRange;
    const aspect = typeof reply.aspect === "number" && reply.aspect >= lo && reply.aspect <= hi ? reply.aspect : null;
    const built = layoutFromSpec(reply.spec);
    if ("problem" in built) {
      fallback(`${built.problem} (${took})`);
    } else if (built.spec.kind === "freeform" && aspect === null) {
      // Freeform zones were placed for the model's aspect; without a plausible one they're guesses.
      fallback(`board aspect ${String(reply.aspect)} is outside ${lo}-${hi} (${took})`);
    } else {
      setLayout(built.layout);
      const { spec, layout: l, warning } = built;
      const board = aspect !== null ? ` Board ≈ ${aspect.toFixed(2)}:1.` : "";
      const notes = spec.notes ? ` Muse Spark: "${spec.notes}".` : "";
      layoutStatusEl.textContent =
        `${heard}Muse Spark spec in ${took}: ${l.instrument}, ${describeSpec(spec, l)}.${board}${notes}` +
        (warning ? ` ⚠ ${warning}.` : "");
    }
  } catch (err) {
    console.error(err);
    fallback(err instanceof Error ? err.message : String(err));
  } finally {
    generating = false;
    updateHint();
  }
}

instrumentInput.placeholder = CONFIG.muse.defaultRequest;
instrumentInput.maxLength = CONFIG.server.maxPromptChars;
instrumentInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") generateLayout();
});
generateBtn.addEventListener("click", () => generateLayout());

// Push-to-talk: hold Space (outside text boxes and pickers) or hold the button, up to
// CONFIG.voice.maxMs. Taps pause from the press until CONFIG.voice.resumeTapsMs after the
// release, so speech doesn't play notes. Muse Voice Transcribe's transcript goes into the
// instrument box and Generate runs on it.
const tapsPaused = () => talk !== null || performance.now() < tapsResumeAt;

function startTalk() {
  if (talk || talkBtn.disabled) return;
  audio.ctx ??= new AudioContext({ latencyHint: "interactive" });
  const startedAt = performance.now();
  const show = () => {
    const secs = ((performance.now() - startedAt) / 1000).toFixed(1);
    layoutStatusEl.textContent = `Listening… ${secs} of ${CONFIG.voice.maxMs / 1000} s. Release to send; taps are paused.`;
  };
  show();
  talk = {
    rec: new Recording(audio.ctx),
    ticker: window.setInterval(show, 100),
    cutoff: window.setTimeout(stopTalk, CONFIG.voice.maxMs),
  };
  talkBtn.classList.add("on");
}

async function stopTalk() {
  if (!talk) return;
  const { rec, ticker, cutoff } = talk;
  clearInterval(ticker);
  clearTimeout(cutoff);
  talk = null;
  tapsResumeAt = performance.now() + CONFIG.voice.resumeTapsMs;
  transcribing = true;
  talkBtn.classList.remove("on");
  updateHint();
  let heard: string | null = null;
  try {
    const speech = await rec.stop();
    if (!speech) {
      layoutStatusEl.textContent = "Too short: hold Space or the talk button while you speak.";
      return;
    }
    const secs = (speech.audioMs / 1000).toFixed(1);
    layoutStatusEl.textContent = `Transcribing ${secs} s of speech…`;
    const t = await transcribe(speech.wav);
    const boost = speech.gain > 1 ? ` ×${speech.gain.toFixed(1)}` : "";
    const timing =
      `${secs} s of audio${boost}; WAV ${speech.encodeMs.toFixed(0)} ms, ` +
      `Muse Voice Transcribe ${t.serverMs} ms, round trip ${t.ms.toFixed(0)} ms`;
    const text = t.text.replace(/[.!?]+$/, "").slice(0, CONFIG.server.maxPromptChars).trim();
    if (!text) {
      layoutStatusEl.textContent = `Heard nothing (${timing}). Try again closer to the mic.`;
      return;
    }
    instrumentInput.value = text;
    heard = `Heard "${text}" (${timing}). `;
  } catch (err) {
    console.error(err);
    layoutStatusEl.textContent = `Voice input failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    transcribing = false;
    updateHint();
  }
  if (heard) generateLayout(heard);
}

const inField = (t: EventTarget | null) =>
  t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;
window.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || inField(e.target)) return;
  e.preventDefault(); // no page scroll, no click on a focused button
  if (!e.repeat) startTalk();
});
window.addEventListener("keyup", (e) => {
  if (e.code !== "Space" || (!talk && inField(e.target))) return;
  e.preventDefault();
  stopTalk();
});
window.addEventListener("blur", stopTalk);
talkBtn.addEventListener("pointerdown", (e) => {
  talkBtn.setPointerCapture(e.pointerId);
  startTalk();
});
talkBtn.addEventListener("pointerup", stopTalk);
talkBtn.addEventListener("pointercancel", stopTalk);

// The finger toggle writes CONFIG.fingers.allowed. Test scores are kept per tap mode,
// finger setting and tap correction, so accuracy before and after calibrating taps, or
// with and without the mic, shows side by side.
const FINGER_SETS: Record<string, string[]> = { index: ["index"], all: FINGER_NAMES };
const fingerSetting = () => {
  const fit = corrections ? `tap correction ${new Date(corrections.fittedAt).toLocaleTimeString()}` : "no tap correction";
  return `${tapModeSelect.selectedOptions[0].text}, ${fingersSelect.selectedOptions[0].text}, ${fit}`;
};

// The tap-mode toggle writes CONFIG.taps.mode. Vision-only needs sound but not the mic.
tapModeSelect.value = CONFIG.taps.mode;
updateAudioButton();
tapModeSelect.addEventListener("change", () => {
  CONFIG.taps.mode = tapModeSelect.value === "vision" ? "vision" : "hybrid";
  updateAudioButton();
  updateTest();
});
fingersSelect.value = CONFIG.fingers.allowed.length === 1 && CONFIG.fingers.allowed[0] === "index" ? "index" : "all";
fingersSelect.addEventListener("change", () => {
  CONFIG.fingers.allowed = FINGER_SETS[fingersSelect.value];
  updateTest();
});

function updateTest() {
  showTest(test.active ? (test.target?.label ?? null) : null, fingerSetting(), test.scores);
}

function setTesting(on: boolean) {
  if (on) {
    setTapCal(false);
    test.start(layout);
  } else test.stop();
  testBtn.textContent = on ? "Stop test" : "Test";
  testBtn.classList.toggle("on", on);
  updateTest();
}

testBtn.addEventListener("click", () => setTesting(!test.active));
resetStatsBtn.addEventListener("click", () => {
  test.resetScores();
  dots.length = 0;
  dropouts.lost.fill(0);
  dropouts.frames.fill(0);
  dropouts.offLost = dropouts.offFrames = 0;
  showDropouts(dropouts);
  updateTest();
});

// Corrections belong to the board they were fitted on: new corners clear them.
function setCorrections(c: TapCorrections | null) {
  corrections = c;
  saveCorrections(c);
  clearCorrectionBtn.disabled = c === null;
  dots.length = 0;
  showCorrections(c);
  updateTest();
}

// While calibrating taps, positions are used raw so the new fit doesn't stack on the old.
function setTapCal(on: boolean) {
  if (on) setTesting(false);
  tapCal = on ? new TapCalibration(layout) : null;
  calTapsBtn.textContent = on ? "Cancel tap calibration" : "Calibrate taps";
  calTapsBtn.classList.toggle("on", on);
  updateTapCalStatus();
}

function updateTapCalStatus(done?: string) {
  const zone = tapCal?.zone;
  tapCalStatusEl.textContent = zone
    ? `Calibrating taps: tap the center of ${zone.label} with an index finger (${tapCal!.progress}).`
    : tapCal
      ? "Calibrating taps: fitting…"
      : (done ?? "");
}

// The new calibration replaces any old correction, even when neither fit is good enough
// to use: it was measured on raw positions, so it's the latest word on the bias.
function finishTapCal() {
  const fit = tapCal!.fit();
  setTapCal(false);
  const describe = (kind: TapKind) => {
    const r = fit[kind];
    const rms = Number.isFinite(r.rmsBefore) ? ` rms ${r.rmsBefore.toFixed(3)} → ${r.rmsAfter.toFixed(3)}` : "";
    return `${kind}${rms} (${r.pairs} taps)${r.why ? `, not applied: ${r.why}` : ", applied"}`;
  };
  const guess = fit.guess.correction;
  const check = fit.check.correction;
  setCorrections(guess || check ? { guess, check, fittedAt: Date.now() } : null);
  const what = guess || check ? "Tap correction saved" : "No tap correction";
  updateTapCalStatus(`${what}: ${describe("guess")}; ${describe("check")}.`);
}

calTapsBtn.addEventListener("click", () => setTapCal(!tapCal));
clearCorrectionBtn.addEventListener("click", () => {
  setCorrections(null);
  updateTapCalStatus("Tap correction cleared.");
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
  const { minSurfaceFrac, looseFitRatio } = CONFIG.sam;
  const prompt = samPromptInput.value.trim() || CONFIG.sam.boundaryPrompt;
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

samPromptInput.value = CONFIG.sam.boundaryPrompt;
samPromptInput.maxLength = CONFIG.server.maxPromptChars;
samPromptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !detectBtn.disabled) detectSurface();
});
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
  setCorrections(null);
  forgetPlayerEdge();
  clearObjects();
  setProposal(null);
  samStatusEl.textContent = "Using the corners from SAM 3.1.";
  hintError = null;
  updateHint();
});

// Object pads replace any earlier scan's.
function setObjects(zones: Zone[]) {
  objects = { instrument: "objects", zones };
  clearObjectsBtn.disabled = zones.length === 0;
}

// They are in board coords, so new corners clear them.
function clearObjects() {
  setObjects([]);
  objectStatusEl.textContent = "";
  objectStatusEl.title = "";
}

// "Scan objects": SAM 3.1 finds the objects in the current frame and Muse Spark names each
// one and picks its sound (object-scan.ts). The status line lists the pads; matches not
// used, and why, go to the console and the line's tooltip.
async function scanForObjects() {
  const H = calibration.camToBoard;
  if (!calibration.done || !H || video.videoWidth === 0 || scanning) return;
  scanning = true;
  updateHint();
  objectStatusEl.title = "";
  const started = performance.now();
  try {
    const r = await scanObjects(video, H, calibration.corners, (text) => (objectStatusEl.textContent = text));
    setObjects(r.zones);
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    const timing =
      `${secs} s: SAM 3.1 ${r.segmentMs.toFixed(0)} ms (${r.matches} matches), ` +
      `Muse Spark ${r.describeMs.toFixed(0)} ms`;
    const failed = r.failedPhrases.length ? ` Phrases that failed: ${r.failedPhrases.join("; ")}.` : "";
    const skipped = r.skipped.length ? ` ${r.skipped.length} matches not used (hover for why).` : "";
    objectStatusEl.textContent = r.zones.length
      ? `${r.zones.length} object pad(s) in ${timing}: ${r.found.join(", ")}.${skipped}${failed}`
      : `No objects found in ${timing}.${skipped}${failed}`;
    objectStatusEl.title = r.skipped.join("\n");
    console.info("object scan", { found: r.found, skipped: r.skipped, zones: r.zones });
  } catch (err) {
    console.error(err);
    objectStatusEl.textContent = `Object scan failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    scanning = false;
    updateHint();
  }
}

scanObjectsBtn.addEventListener("click", scanForObjects);
clearObjectsBtn.addEventListener("click", clearObjects);

// The zone a tap at p (board coords) plays: an object pad if one is there (they sit above
// every instrument zone), else the layout's. With no objects scanned, the layout's only.
function zoneAt(p: Pt): Zone | null {
  return (objects.zones.length ? hitTest(objects, p) : null) ?? hitTest(layout, p);
}

const onObject = (p: Pt) => objects.zones.length > 0 && hitTest(objects, p) !== null;

// The button starts whatever the tap mode still needs: sounds always, the mic only in
// hybrid mode.
function updateAudioButton() {
  const needMic = CONFIG.taps.mode === "hybrid" && !audio.micOn;
  micBtn.disabled = audio.starting || (audio.soundOn && !needMic);
  if (audio.starting) return;
  micBtn.textContent = needMic ? "Enable mic" : !audio.soundOn ? "Enable sound" : audio.micOn ? "Mic on" : "Sound on";
}

function onLevel(l: MicLevel) {
  showLevel(l);
  levels.push(l);
  while (levels.length && levels[0].time < l.time - CONFIG.motion.keepMs) levels.shift();
}

// One AudioContext, created inside the first click, for both the mic detector and Tone.
// Sounds load and warm up here so the first tap isn't silent.
micBtn.addEventListener("click", async () => {
  const startMicToo = CONFIG.taps.mode === "hybrid" && !audio.micOn;
  audio.starting = true;
  updateAudioButton();
  micBtn.textContent = startMicToo ? "Starting mic, loading sounds…" : "Loading sounds…";
  try {
    audio.ctx ??= new AudioContext({ latencyHint: "interactive" });
    const ctx = audio.ctx;
    await ctx.resume();
    await Promise.all([
      startMicToo && startMic(ctx, { onOnset, onLevel, onInfo: showMicInfo }).then(() => (audio.micOn = true)),
      !audio.soundOn && initSound(ctx).then(() => (audio.soundOn = true)),
    ]);
    audio.starting = false;
    updateAudioButton();
  } catch (err) {
    console.error(err);
    audio.starting = false;
    updateAudioButton();
    micBtn.textContent += ` (${err instanceof Error ? err.message : String(err)})`;
  }
});

function keepRecent(times: number[], t: number) {
  times.push(t);
  while (times.length && times[0] < t - CONFIG.motion.keepMs) times.shift();
}

// A finger struck and stopped on the board (from FingerHistory.newStops, once per
// stroke). In vision-only mode that is the tap; in hybrid test mode, it is checked for a
// matching onset.
function onStop(m: FingerPick) {
  if (tapsPaused()) return;
  if (CONFIG.taps.mode === "vision") visionTap(m);
  else if (test.active && !tapCal && audio.micOn) checkMiss(m);
}

// Vision-only: plays at the stop frame's position, through the check correction, unless
// the zone is in its refractory. Each finger's stop is its own tap, so chords play as
// their fingers stop. Scored in test mode and recorded in tap calibration like an onset
// tap whose guess and check are the same position.
function visionTap(m: FingerPick) {
  const n = ++tapCount;
  const at = tapPoint("check", landing(m.at));
  const zone = at ? zoneAt(at) : null;
  const played = zone && zoneReady(zone) ? playZone(zone) : null;
  const latencyMs = played ? performance.now() - m.at.t + played.outputMs : null;
  setLastTap(m.finger, m.at.t);
  const line = logVisionTap(n, m.finger, zone?.label ?? null, latencyMs);

  if (tapCal) {
    const cal = tapCal;
    const target = cal.take();
    if (!target) return;
    if (at) pushDot({ guess: { p: at, hit: zone?.id === target.id }, check: null });
    cal.add("guess", target, at);
    cal.add("check", target, at);
    cal.settle();
    updateTapCalStatus();
    if (cal.finished) finishTapCal();
    return;
  }
  const joined = test.active ? test.join(m.at.t, fingerSetting(), layout) : null;
  if (!joined) return;
  const { attempt, opened } = joined;
  if (zone) {
    attempt.played.add(zone.id);
    attempt.checked.add(zone.id);
  }
  if (at) pushDot({ guess: { p: at, hit: !!zone && attempt.target.zones.some((z) => z.id === zone.id) }, check: null });
  if (opened) {
    attempt.line = line;
    closeAttemptAt(attempt, attempt.start + attempt.window);
  }
  updateTest();
}

// Scores a test attempt once every tap in its window has played and been checked.
function closeAttemptAt(a: Attempt, t: number) {
  setTimeout(() => {
    const hit = test.record(a);
    if (a.line) logTest(a.line, a.target.label, hit);
    updateTest();
  }, Math.max(0, t + 5 - performance.now()));
}

// Per-zone refractory: a zone can't play again within zoneRefractoryMs; other zones can,
// so the second finger of a chord isn't cut off.
function zoneReady(zone: Zone): boolean {
  return performance.now() - (zonePlayedAt.get(zone.id) ?? -Infinity) >= CONFIG.taps.zoneRefractoryMs;
}

// Plays a zone now and starts its refractory and flash.
function playZone(zone: Zone): { ctxTime: number; outputMs: number } | null {
  const now = performance.now();
  zonePlayedAt.set(zone.id, now);
  flashes.set(zone.id, now + CONFIG.taps.flashMs);
  return playNow(zone.sound);
}

// Hybrid test mode: a stop with no accepted onset within missWindowMs of when its onset
// would have been (videoLagMs before the stop frame) is logged as a miss, with the peak
// mic level around then. Waits until onsets for the whole window are in.
function checkMiss(m: FingerPick) {
  const expected = m.at.t - CONFIG.taps.videoLagMs;
  const lo = expected - CONFIG.motion.missWindowMs;
  const hi = expected + CONFIG.motion.missWindowMs;
  const inWindow = (t: number) => t >= lo && t <= hi;
  setTimeout(() => {
    if (acceptedOnsets.some(inWindow)) return;
    // A level report covers the reportMs before its time.
    const near = levels.filter((l) => l.time >= lo && l.time <= hi + CONFIG.onset.reportMs);
    const peak = near.reduce<MicLevel | null>((a, l) => (!a || l.level > a.level ? l : a), null);
    const at = tapPoint("check", landing(m.at));
    const zone = at ? zoneAt(at) : null;
    logMissed(m.finger, zone?.label ?? null, peak, rejectedOnsets.some(inWindow));
  }, Math.max(0, hi + CONFIG.taps.settleMarginMs - performance.now()));
}

// A guess or check position (cam coords) on the board, with its tap correction applied.
function tapPoint(kind: TapKind, cam: Pt): Pt | null {
  if (!calibration.camToBoard) return null;
  const raw = applyH(calibration.camToBoard, cam);
  return tapCal ? raw : applyCorrection(corrections?.[kind] ?? null, raw);
}

function pushDot(dot: (typeof dots)[number]) {
  dots.push(dot);
  while (dots.length > CONFIG.taps.dotTaps) dots.shift();
}

function toBoard(p: Pt): Pt | null {
  return calibration.camToBoard ? applyH(calibration.camToBoard, p) : null;
}

// On the board, or on an object pad (objects may sit off the board).
function onBoard(p: Pt): boolean {
  if (!calibration.camToBoard) return false;
  const b = applyH(calibration.camToBoard, p);
  return (b.x >= 0 && b.x <= 1 && b.y >= 0 && b.y <= 1) || onObject(b);
}

// Remembers the tapping hand for the next guess. The stop-based check, known later,
// overrides the guess unless a newer tap has come in since.
function setLastTap(finger: string, t: number) {
  if (!lastTap || t >= lastTap.t) lastTap = { hand: handOf(finger), t };
}

// A finger's tap position on the board and the zone there. late: a check stop past
// lateStopMs, so at is the finger's guess position instead.
type Note = { pick: FingerPick; at: Pt | null; zone: Zone | null; late: boolean };

// Board coords on the board or on an object pad.
const insideBoard = (p: Pt | null) => !!p && ((p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) || onObject(p));

// The chord in a ranked list of fingers: every strike (each must pass on its own) landing
// on the board and scoring at least chordRatio of the best such strike (the best first),
// one per zone. A finger landing off the board can't play, so it is no candidate and
// doesn't set the ratio; one landing in a gap between zones stays in, with no zone.
// rejected: why each other finger isn't in it, with the measured value.
function chordOf(notes: Note[]): { chord: Note[]; rejected: string[] } {
  const rejected: string[] = [];
  const strikes = notes.filter(({ pick, at }) => {
    if (pick.why) rejected.push(`${pick.finger} ${pick.why}`);
    else if (!insideBoard(at)) {
      const where = at ? ` (${at.x.toFixed(2)}, ${at.y.toFixed(2)})` : "";
      rejected.push(`${pick.finger} lands off board${where}`);
    } else return true;
    return false;
  });
  if (strikes.length === 0) return { chord: [], rejected };
  const best = strikes[0].pick.score;
  const { chordRatio } = CONFIG.taps;
  const zones = new Set<string>();
  const chord = strikes.filter(({ pick, zone }) => {
    if (pick.score < best * chordRatio) {
      rejected.push(`${pick.finger} below ratio (${(pick.score / best).toFixed(2)} < ${chordRatio})`);
      return false;
    }
    if (!zone) return true;
    if (zones.has(zone.id)) return false;
    zones.add(zone.id);
    return true;
  });
  return { chord, rejected };
}

// Finger names in a stable order, so a guessed and a checked chord compare as text.
const fingerList = (notes: Note[]) => notes.map((x) => x.pick.finger).sort().join(" + ");
const zoneList = (notes: Note[]) => notes.map((x) => x.zone?.label ?? "off board").join(" + ");

// Plays right away from the best-guess fingers: every striking finger whose score is at
// least chordRatio of the best one's, one note per zone, except zones still in their
// refractory. Only fingers whose projected landing point is on the board are candidates.
// Fingers that move but fall short or land off the board are listed in the tap log with
// why. The ratio is always taken against the best on-board finger, refractory or not,
// so a second onset from the same tap can't promote a weaker finger, while the second
// finger of a slightly staggered chord plays on its own onset if it would have joined
// the chord anyway.
//
// The finger frames for the moment of the onset arrive videoLagMs later and the stop may
// be up to the stop window's end after that, so the tap is checked against the stopped fingers
// once those frames are in. In test mode, the tap joins the current attempt (a chord's
// fingers may land with separate onsets) and the attempt is scored once all its taps are
// checked; in tap calibration the best finger's positions are recorded against the zone
// being calibrated.
//
// Hybrid mode gate: an onset only counts if some allowed finger strikes; otherwise it is
// logged as rejected, with each moving finger's shortfall. Onsets are ignored in
// vision-only mode.
function onOnset(onset: Onset) {
  if (CONFIG.taps.mode !== "hybrid" || tapsPaused()) return;
  const n = ++tapCount;
  if (handsInFrame === 0) {
    logIgnored(n, "no hand");
    return;
  }
  const { videoLagMs, settleMarginMs } = CONFIG.taps;
  // One window for both the guess and the check of this onset.
  const win = stopWindow(frameMs);
  const recent = lastTap && onset.time - lastTap.t <= CONFIG.guess.lastHandMs;
  const guesses = history
    .guessAll(onset.time, { toBoard, onBoard, lastHand: recent ? lastTap!.hand : null, window: win })
    .map((pick): Note => {
      const at = tapPoint("guess", landing(pick.at));
      return { pick, at, zone: at ? zoneAt(at) : null, late: false };
    });
  const { chord, rejected } = chordOf(guesses);
  if (chord.length === 0) {
    keepRecent(rejectedOnsets, onset.time);
    logRejected(n, onset, rejected);
    return;
  }
  keepRecent(acceptedOnsets, onset.time);
  const played: Zone[] = [];
  let latencyMs: number | null = null;
  for (const { pick, zone } of chord) {
    if (!zone) continue;
    if (!zoneReady(zone)) {
      rejected.push(`${pick.finger} ${zone.label} in refractory`);
      continue;
    }
    const p = playZone(zone);
    if (!p) continue;
    played.push(zone);
    latencyMs ??= (p.ctxTime - onset.ctxTime) * 1000 + p.outputMs;
  }
  const handlerMs = performance.now() - onset.receivedAt;
  const best = chord[0] ?? null;
  if (best) setLastTap(best.pick.finger, onset.time);
  const line = logPlayed({
    n,
    finger: chord.length ? fingerList(chord) : null,
    zone: played.length ? played.map((z) => z.label).join(" + ") : null,
    latencyMs,
    waitMs: onset.receivedAt - onset.time,
    handlerMs,
    rejected,
  });

  // Taps after the last calibration zone (while its checks resolve) count for nothing.
  const calTarget = tapCal?.take() ?? null;
  const cal = calTarget ? tapCal : null;
  const joined = !tapCal && test.active ? test.join(onset.time, fingerSetting(), layout) : null;
  const attempt = joined?.attempt ?? null;
  const resolveAt = onset.time + videoLagMs + win.hi + settleMarginMs;
  if (attempt) {
    for (const z of played) attempt.played.add(z.id);
    if (joined!.opened) {
      attempt.line = line;
      // After the resolve of the last onset that can still join.
      closeAttemptAt(attempt, resolveAt + attempt.window);
    }
    updateTest();
  }
  const targetHas = (zone: Zone | null) =>
    !!zone && (calTarget ? zone.id === calTarget.id : !!attempt?.target.zones.some((z) => z.id === zone.id));
  if (cal) {
    cal.add("guess", calTarget!, best?.at ?? null);
    updateTapCalStatus();
  }
  const dot: (typeof dots)[number] = { guess: null, check: null };
  if (calTarget || attempt) {
    if (best?.at) dot.guess = { p: best.at, hit: targetHas(best.zone) };
    pushDot(dot);
  }

  setTimeout(() => {
    // A late stop is the finger settling after contact; its guess position is better.
    const guessAt = new Map(guesses.map((g) => [g.pick.finger, g.at]));
    const { chord: checks, rejected: checkRejected } = chordOf(
      history.resolveAll(onset.time, toBoard, win).map((pick): Note => {
        const early = guessAt.get(pick.finger) ?? null;
        const late = pick.stopOffset! > CONFIG.taps.lateStopMs && early !== null;
        const at = late ? early : tapPoint("check", landing(pick.at));
        return { pick, at, zone: at ? zoneAt(at) : null, late };
      }),
    );
    const top = checks[0] ?? null;
    if (top) setLastTap(top.pick.finger, onset.time);
    resolveTap(line, fingerList(chord), {
      finger: checks.length ? fingerList(checks) : null,
      zone: checks.length ? zoneList(checks) : null,
      stopOffset: top?.pick.stopOffset ?? null,
      late: !!top?.late,
      rejected: checkRejected,
    });
    if ((calTarget || attempt) && top?.at) dot.check = { p: top.at, hit: targetHas(top.zone) };
    if (cal) {
      // Only on-time stops go into the check fit; late ones aren't check positions.
      cal.add("check", calTarget!, top && !top.late ? top.at : null);
      cal.settle();
      if (cal === tapCal && cal.finished) finishTapCal();
    } else if (attempt) {
      for (const { zone } of checks) if (zone) attempt.checked.add(zone.id);
    }
  }, Math.max(0, resolveAt - performance.now()));
}

// Fingers are keyed by the hand's tracking ID, which follows the physical hand.
// Motion comes from the raw landmarks, the landing position from the filtered tips.
function recordFingers(hands: TrackedHand[], detectedAt: number) {
  for (const { id, raw, tips } of hands) {
    FINGERTIPS.forEach((tip, f) => {
      history.add(fingerKey(id, FINGER_NAMES[f]), {
        t: detectedAt,
        x: raw[tip].x,
        y: raw[tip].y,
        fx: tips[f].x,
        fy: tips[f].y,
      });
    });
  }
}

// Board column of a camera point, or -1 if off the board or there is no board.
function boardColumn(p: Pt): number {
  if (!calibration.camToBoard) return -1;
  const b = applyH(calibration.camToBoard, p);
  if (!(b.x >= 0 && b.x < 1 && b.y >= 0 && b.y <= 1)) return -1;
  return Math.floor(b.x * CONFIG.hands.dropoutColumns);
}

function countDropouts(hands: TrackedHand[], lost: Pt[]) {
  const index = FINGERTIPS.indexOf(8);
  for (const hand of hands) {
    const c = boardColumn(hand.tips[index]);
    if (c < 0) dropouts.offFrames++;
    else dropouts.frames[c]++;
  }
  for (const p of lost) {
    const c = boardColumn(p);
    if (c < 0) dropouts.offLost++;
    else dropouts.lost[c]++;
  }
}

type CameraMode = { width: number; height: number; frameRate: number };
export type CameraInfo = { asked: CameraMode; settings: MediaTrackSettings };
export type CameraProbe = CameraInfo & { fps: number };
let camera: CameraInfo | null = null;
// Mean interval between new video frames over the last second, ms (null until measured).
// The tap stop window stretches with it.
let frameMs: number | null = null;

async function openCamera(mode: CameraMode): Promise<MediaStream> {
  (video.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: mode.width }, height: { ideal: mode.height }, frameRate: { ideal: mode.frameRate } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  return stream;
}

// New video frames per second, measured over ms.
function measureFps(ms: number): Promise<number> {
  return new Promise((resolve) => {
    let first = -1;
    let n = 0;
    const step = (now: number) => {
      if (first < 0) first = now;
      else n++;
      if (now - first < ms) video.requestVideoFrameCallback(step);
      else resolve((n * 1000) / (now - first));
    };
    video.requestVideoFrameCallback(step);
  });
}

async function startCamera(): Promise<CameraInfo> {
  const asked = CONFIG.camera.mode;
  const stream = await openCamera(asked);
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  return { asked, settings: stream.getVideoTracks()[0].getSettings() };
}

// Debug: what the probe mode really delivers once settled, then back to the normal mode.
// Taps during the probe see the other mode's framing.
probeBtn.addEventListener("click", async () => {
  const { probe, probeWarmupMs, probeMs } = CONFIG.camera;
  probeBtn.disabled = true;
  showProbe("running");
  try {
    const stream = await openCamera(probe);
    await new Promise((r) => setTimeout(r, probeWarmupMs));
    const fps = await measureFps(probeMs);
    showProbe({ asked: probe, settings: stream.getVideoTracks()[0].getSettings(), fps });
  } catch (err) {
    showProbe(err instanceof Error ? err.message : String(err));
  } finally {
    try {
      camera = await startCamera();
    } catch (err) {
      setStatus(`Camera error: ${err instanceof Error ? err.message : String(err)}`);
    }
    probeBtn.disabled = false;
  }
});

// Hand detection, in the worker or on the main thread (see CONFIG.hands.detectOn). Counts
// are totals since startup; the panel and the auto choice take differences. handleMs: the
// main thread's own work per result (tracking, finger history, strikes); draws and drawMs:
// canvas redraws.
let detector: Detector | null = null;
let hands: TrackedHand[] = [];
const counts = { videoFrames: 0, detections: 0, detectMs: 0, handleMs: 0, draws: 0, drawMs: 0 };
// Something to show since the last redraw: a new video frame or new hand results.
let dirty = true;
let detectorChoice: string | null = null;

function useDetector(d: Detector) {
  d.onHands = (t: number, frame: HandFrame, ms: number) => {
    if (detector !== d) return;
    const start = performance.now();
    counts.detections++;
    counts.detectMs += ms;
    const tracked = tracking.update(frame, t, video.videoWidth / video.videoHeight);
    for (const id of tracked.started) {
      history.dropHand(id);
      if (lastTap?.hand === id) lastTap = null;
    }
    hands = tracked.hands;
    recordFingers(hands, t);
    trackPlayerEdge(hands, t);
    const hold = CONFIG.taps.mode === "vision" ? CONFIG.taps.visionHoldFrames : 0;
    for (const m of history.newStops(toBoard, onBoard, hold)) onStop(m);
    countDropouts(hands, tracked.lost);
    handsInFrame = hands.length;
    dirty = true;
    counts.handleMs += performance.now() - start;
  };
  detector = d;
}

// Camera and detection rates over autoMeasureMs, after autoWarmupMs to settle.
async function measureDetection(): Promise<{ camera: number; detection: number }> {
  const { autoWarmupMs, autoMeasureMs } = CONFIG.hands;
  await new Promise((r) => setTimeout(r, autoWarmupMs));
  const f0 = counts.videoFrames;
  const d0 = counts.detections;
  const t0 = performance.now();
  await new Promise((r) => setTimeout(r, autoMeasureMs));
  const secs = (performance.now() - t0) / 1000;
  return { camera: (counts.videoFrames - f0) / secs, detection: (counts.detections - d0) / secs };
}

// "auto": keep the worker if it keeps up with the camera. Otherwise try the main thread
// and keep whichever detects more frames per second.
async function chooseDetector(worker: Detector) {
  const keepsUp = (m: { camera: number; detection: number }) => m.detection >= m.camera * CONFIG.hands.keepUpRatio;
  detectorChoice = "auto: measuring worker…";
  const w = await measureDetection();
  const rate = (name: string, m: { detection: number }) => `${name} ${m.detection.toFixed(0)}/s`;
  if (keepsUp(w)) {
    detectorChoice = `auto: ${rate("worker", w)} keeps up with camera ${w.camera.toFixed(0)} fps`;
    return;
  }
  detectorChoice = `auto: ${rate("worker", w)} < camera ${w.camera.toFixed(0)} fps, measuring main thread…`;
  const main = await createDetector("main", video);
  useDetector(main);
  const m = await measureDetection();
  const pick = keepsUp(m) || m.detection > w.detection ? main : worker;
  useDetector(pick);
  (pick === main ? worker : main).close();
  detectorChoice =
    `auto: ${rate("worker", w)}, ${rate("main", m)}, camera ${m.camera.toFixed(0)} fps → ` +
    (pick === main ? "main thread" : "worker");
}

// Filtered fingertips are hit-tested like a stopped finger, through the check correction.
function zonesUnderFingertips(hands: TrackedHand[]): Set<string> {
  const hits = new Set<string>();
  for (const hand of hands) {
    FINGERTIPS.forEach((_, f) => {
      if (!CONFIG.fingers.allowed.includes(FINGER_NAMES[f])) return;
      const p = tapPoint("check", hand.tips[f]);
      const zone = p ? zoneAt(p) : null;
      if (zone) hits.add(zone.id);
    });
  }
  return hits;
}

function tracePath(pts: Pt[], close: boolean) {
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  if (close) ctx.closePath();
}

// Low z first, each zone clipped to what the zones above it leave visible (even-odd: the
// whole canvas minus their outlines), so black keys sit on top of the white keys under them
// and white keys' outlines stop at their edges. Labels go on afterwards, at each zone's
// visible anchor.
function drawLayout(active: Set<string>, now: number) {
  if (!calibration.done) return;
  const outlines = new Map(layout.zones.map((z) => [z.id, shapeOutline(z.shape).map(boardToScreen)]));
  for (const { zone, above } of zStack(layout)) {
    const outline = outlines.get(zone.id)!;
    ctx.save();
    if (above.length) {
      ctx.beginPath();
      ctx.rect(0, 0, canvas.width, canvas.height);
      for (const o of above) {
        outlines.get(o.id)!.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.closePath();
      }
      ctx.clip("evenodd");
    }
    tracePath(outline, true);
    const idle = isAccidental(zone) ? "rgba(0, 0, 0, 0.45)" : "rgba(255, 255, 255, 0.12)";
    ctx.fillStyle = active.has(zone.id) ? "rgba(255, 196, 0, 0.55)" : idle;
    ctx.fill();
    const flashLeft = (flashes.get(zone.id) ?? 0) - now;
    if (flashLeft > 0) {
      ctx.fillStyle = `rgba(0, 220, 255, ${(0.85 * flashLeft) / CONFIG.taps.flashMs})`;
      ctx.fill();
    }
    const isTarget = tapCal ? zone.id === tapCal.zone?.id : test.isTarget(zone);
    if (isTarget) {
      ctx.fillStyle = "rgba(0, 230, 118, 0.35)";
      ctx.fill();
    }
    ctx.strokeStyle = isTarget ? "#00e676" : "rgba(255, 255, 255, 0.85)";
    ctx.lineWidth = isTarget ? 5 : 2;
    ctx.stroke();
    ctx.restore();
  }
  for (const zone of layout.zones) drawLabel(zone, outlines.get(zone.id)!);
  if (tapCal?.zone) drawCrosshair(boardToScreen(zoneAnchor(layout, tapCal.zone)));
}

// Object pads over the layout, magenta: outline, fill (yellow under a fingertip, cyan
// flash when played), and the object's name with its sound at the outline's center.
function drawObjects(active: Set<string>, now: number) {
  if (!calibration.done) return;
  for (const zone of objects.zones) {
    const outline = shapeOutline(zone.shape).map(boardToScreen);
    tracePath(outline, true);
    ctx.fillStyle = active.has(zone.id) ? "rgba(255, 196, 0, 0.55)" : "rgba(255, 0, 200, 0.18)";
    ctx.fill();
    const flashLeft = (flashes.get(zone.id) ?? 0) - now;
    if (flashLeft > 0) {
      ctx.fillStyle = `rgba(0, 220, 255, ${(0.85 * flashLeft) / CONFIG.taps.flashMs})`;
      ctx.fill();
    }
    ctx.strokeStyle = "#ff00c8";
    ctx.lineWidth = 2;
    ctx.stroke();
    const c = {
      x: outline.reduce((s, p) => s + p.x, 0) / outline.length,
      y: outline.reduce((s, p) => s + p.y, 0) / outline.length,
    };
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillStyle = "#ffffff";
    for (const [text, size, dy] of [[zone.label, 15, -9], [soundName(zone.sound), 12, 9]] as const) {
      ctx.font = `600 ${size}px system-ui, sans-serif`;
      ctx.strokeText(text, c.x, c.y + dy);
      ctx.fillText(text, c.x, c.y + dy);
    }
  }
}

// The point to tap during tap calibration.
function drawCrosshair(c: Pt) {
  ctx.strokeStyle = "#00e676";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(c.x - 14, c.y);
  ctx.lineTo(c.x + 14, c.y);
  ctx.moveTo(c.x, c.y - 14);
  ctx.lineTo(c.x, c.y + 14);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(c.x, c.y, 8, 0, Math.PI * 2);
  ctx.stroke();
}

// Guess positions as filled dots, check positions as rings; green hit the target, red
// missed. Positions outside the board are drawn where they fell.
function drawDots() {
  if (!calibration.done) return;
  for (const { guess, check } of dots) {
    for (const [d, filled] of [[guess, true], [check, false]] as const) {
      if (!d) continue;
      const s = boardToScreen(d.p);
      const color = d.hit ? "#00e676" : "#ff3b6b";
      ctx.beginPath();
      ctx.arc(s.x, s.y, filled ? 4 : 6, 0, Math.PI * 2);
      if (filled) {
        ctx.fillStyle = color;
        ctx.fill();
      } else {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }
}

// Text stays upright in screen space, sized to the key's on-screen footprint.
function drawLabel(zone: Zone, outline: Pt[]) {
  const c = boardToScreen(zoneAnchor(layout, zone));
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

// Raw skeleton with the fingertips at their filtered positions.
function drawHands(hands: TrackedHand[]) {
  for (const hand of hands) {
    const pts = hand.raw.map((p, i) => camToScreen(FINGERTIPS.includes(i) ? hand.tips[FINGERTIPS.indexOf(i)] : p));
    ctx.strokeStyle = "rgba(0, 255, 180, 0.8)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (const [start, end] of HAND_CONNECTIONS) {
      ctx.moveTo(pts[start].x, pts[start].y);
      ctx.lineTo(pts[end].x, pts[end].y);
    }
    ctx.stroke();

    pts.forEach((p, i) => {
      const f = FINGERTIPS.indexOf(i);
      const tip = f >= 0 && CONFIG.fingers.allowed.includes(FINGER_NAMES[f]);
      ctx.fillStyle = tip ? "#ff3b6b" : "#ffffff";
      ctx.beginPath();
      ctx.arc(p.x, p.y, tip ? 7 : 4, 0, Math.PI * 2);
      ctx.fill();
    });
    drawHandId(hand.id, pts[0]);
  }
}

const HAND_ID_COLORS: Record<string, string> = { A: "#00dcff", B: "#ffb300" };

// The hand's tracking ID in a badge just past the wrist, so it stays clear of the fingers.
function drawHandId(id: string, wrist: Pt) {
  const c = { x: wrist.x, y: wrist.y + 26 };
  ctx.fillStyle = HAND_ID_COLORS[id] ?? "#ffffff";
  ctx.beginPath();
  ctx.arc(c.x, c.y, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = "700 16px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#000000";
  ctx.fillText(id, c.x, c.y);
}

// Every new video frame goes to the detector, stamped with when it was grabbed, so finger
// samples are timed as before. Drawing runs on animation frames with the latest hands, but
// only when there is a new video frame or new hands: animation frames come at the display's
// rate (240 Hz on some laptops), and redrawing the full video that often takes GPU time
// from hand detection on the same GPU.
function loop() {
  let fpsStart = performance.now();
  let last = { ...counts };

  const onFrame = () => {
    counts.videoFrames++;
    dirty = true;
    detector?.frame(performance.now());
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);

  const tick = () => {
    const now = performance.now();

    if (dirty) {
      dirty = false;
      counts.draws++;
      // Only the video is drawn through a mirror transform; overlays use screen coords so
      // text stays readable.
      ctx.setTransform(-1, 0, 0, 1, canvas.width, 0);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const active = zonesUnderFingertips(hands);
      drawLayout(active, now);
      drawObjects(active, now);
      drawDots();
      drawCorners(calibration.corners, calibration.done, "#ffd400");
      drawProposal();
      drawHands(hands);
      counts.drawMs += performance.now() - now;
    }

    if (now - fpsStart >= 1000) {
      const secs = (now - fpsStart) / 1000;
      const fps = (counts.videoFrames - last.videoFrames) / secs;
      frameMs = fps > 0 ? 1000 / fps : null;
      const n = counts.detections - last.detections;
      const draws = counts.draws - last.draws;
      const per = (ms: number, k: number) => (k ? (ms / k).toFixed(2) : "–");
      setStatus(
        `${hands.length} hand(s) · ${fps.toFixed(0)} fps · ` +
          `main ${per(counts.handleMs - last.handleMs, n)} ms/result · ` +
          `draw ${(draws / secs).toFixed(0)}/s, ${per(counts.drawMs - last.drawMs, draws)} ms`,
      );
      if (camera) showCamera(camera, fps);
      if (detector) {
        const meanMs = n ? (counts.detectMs - last.detectMs) / n : null;
        showDetection(detector.kind, detector.info, n / secs, meanMs, detectorChoice);
      }
      showDropouts(dropouts);
      updatePlayerPanel();
      last = { ...counts };
      fpsStart = now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function main() {
  try {
    setStatus("Starting camera and hand model…");
    // ?detect=worker|main|auto overrides CONFIG.hands.detectOn, for comparing them.
    const param = new URLSearchParams(location.search).get("detect");
    const detectOn = param === "worker" || param === "main" || param === "auto" ? param : CONFIG.hands.detectOn;
    const first = createDetector(detectOn === "main" ? "main" : "worker", video);
    camera = await startCamera();
    showCamera(camera, null);
    calibration.load(`${video.videoWidth}x${video.videoHeight}`);
    // A saved tap correction without the board it was fitted on is stale.
    setCorrections(calibration.done ? corrections : null);
    updateHint();
    setStatus("Loading hand model…");
    useDetector(await first);
    loop();
    setStatus("Running");
    if (detectOn === "auto") await chooseDetector(detector!);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

main();
