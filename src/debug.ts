import { CONFIG } from "./config.ts";
import type { DetectorKind } from "./detectors.ts";
import type { DetectorInfo } from "./hand-detector.ts";
import type { CameraInfo, CameraProbe } from "./main.ts";
import type { MicInfo, MicLevel, Onset } from "./mic.ts";
import type { Edge } from "./orientation.ts";
import { loadSmoothing, saveSmoothing, setSmoothing, SMOOTHING_DEFAULTS, type Jitter } from "./smoothing.ts";
import { FINGER_NAMES, fingerKey, handOf } from "./taps.ts";
import type { Correction, TapCorrections } from "./tap-correction.ts";
import type { TestScore } from "./test-mode.ts";

const el = (id: string) => document.querySelector<HTMLElement>(`#${id}`)!;
const levelEl = el("mic-level");
const floorEl = el("mic-floor");
const thresholdEl = el("mic-threshold");
const meterLevel = el("meter-level");
const meterThreshold = el("meter-threshold");
const fingerEl = el("chosen-finger");
const tapLatencyEl = el("tap-latency");
const medianLatencyEl = el("median-latency");
const offsetEl = el("stop-offset");
const medianOffsetEl = el("median-offset");
const audioLatencyEl = el("audio-latency");
const outputLatencyEl = el("output-latency");
const audioClockEl = el("audio-clock");
const testPanelEl = el("test-panel");
const testStatsEl = el("test-stats");
const tapCorrectionEl = el("tap-correction");
const playerEdgeEl = el("player-edge");
const cameraEl = el("camera-info");
const cameraWarningEl = el("camera-warning");
const probeEl = el("camera-probe");
const detectionEl = el("detection");
const dropoutsEl = el("dropouts");
const logEl = el("tap-log");
const recentOffsets: number[] = [];
const recentLatencies: number[] = [];
const recentWaits: number[] = [];
const recentVision: number[] = [];
const visionLatencyEl = el("vision-latency");
const minCutoffInput = el("min-cutoff") as HTMLInputElement;
const betaInput = el("beta") as HTMLInputElement;
const jitterEl = el("jitter");

// What was played at onset time from the best-guess fingers. waitMs: onset to the main
// thread getting the message; handlerMs: from then to the trigger. rejected: each other
// moving finger and why it didn't play, with the measured value.
export type PlayedTap = {
  n: number;
  finger: string | null;
  zone: string | null;
  latencyMs: number | null;
  waitMs: number;
  handlerMs: number;
  rejected: string[];
};
// The fingers that struck and stopped, known once late frames are in. late: the stop was
// past lateStopMs, so zone comes from the guess position. rejected: as for PlayedTap.
export type ResolvedTap = {
  finger: string | null;
  zone: string | null;
  stopOffset: number | null;
  late: boolean;
  rejected: string[];
};

const notPlayed = (rejected: string[]) => (rejected.length ? ` · not played: ${rejected.join("; ")}` : "");

const db = (v: number) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
const fmtDb = (v: number) => `${Math.max(-99, db(v)).toFixed(0)} dB`;
// Meter spans -80..0 dBFS.
const meterPct = (v: number) => `${Math.min(100, Math.max(0, ((db(v) + 80) / 80) * 100))}%`;
const fmtMs = (ms: number | null) => (ms === null ? "–" : `${ms >= 0 ? "+" : ""}${ms.toFixed(0)} ms`);
const where = (finger: string, zone: string | null) => `${finger} → ${zone ?? "off board"}`;

export function showLevel(l: MicLevel) {
  levelEl.textContent = fmtDb(l.level);
  floorEl.textContent = fmtDb(l.floor);
  thresholdEl.textContent = fmtDb(l.threshold);
  meterLevel.style.width = meterPct(l.level);
  meterThreshold.style.left = meterPct(l.threshold);
}

// Raw track values are shown exactly as reported, in their spec units.
export function showMicInfo(i: MicInfo) {
  const rates = `${(i.ctxRate / 1000).toFixed(1)} kHz ctx / ${i.micRate ? `${(i.micRate / 1000).toFixed(1)} kHz` : "?"} mic`;
  const raw = (v: number | null) => (v === null ? "n/a" : String(v));
  const slow = i.outputRawMs > CONFIG.sound.outputLatencyWarnMs;
  outputLatencyEl.hidden = false;
  outputLatencyEl.classList.toggle("warn", slow);
  outputLatencyEl.textContent =
    `Output latency ${i.outputRawMs.toFixed(0)} ms` + (slow ? " · Bluetooth audio? switch to wired" : "");
  audioLatencyEl.textContent =
    `out ${i.outputMs.toFixed(0)} ms applied (raw ${i.outputRawMs.toFixed(1)} ms) · ` +
    `in 0 ms applied (stats raw ${raw(i.inputStatsRaw)} ms, settings raw ${raw(i.inputSettingsRaw)} s) · ${rates}`;
  // Offset: performance.now() ms at audio-clock 0, smoothed. Drift in ms per minute and ppm.
  const c = i.clock;
  const drift =
    c.driftMsPerMin === null
      ? "drift measuring…"
      : `drift ${c.driftMsPerMin >= 0 ? "+" : ""}${c.driftMsPerMin.toFixed(2)} ms/min (${((c.driftMsPerMin / 60_000) * 1e6).toFixed(0)} ppm)`;
  audioClockEl.textContent = `offset ${c.offsetMs.toFixed(1)} ms (${fmtMs(c.sinceStartMs)} since start) · ${drift} · ${c.source}`;
}

function appendLog(text: string): HTMLLIElement {
  const li = document.createElement("li");
  li.textContent = text;
  logEl.prepend(li);
  while (logEl.children.length > CONFIG.taps.logSize) logEl.lastElementChild!.remove();
  return li;
}

export function logIgnored(n: number, reason: string) {
  appendLog(`#${n} ignored (${reason})`);
}

// Hybrid mode: an onset with no striking finger landing on the board; rejected says why
// each moving one fell short or can't play.
export function logRejected(n: number, o: Onset, rejected: string[]) {
  const why = rejected.length ? rejected.join("; ") : "no finger moving down";
  const rise = `rise ${(20 * Math.log10(o.rise)).toFixed(0)} dB`;
  appendLog(`#${n} rejected (no strike on the board: ${why}) · ${fmtDb(o.level)} vs threshold ${fmtDb(o.threshold)}, ${rise}`);
}

// Test mode: a finger came down and stopped on the board but no onset was accepted
// around it. peak: the loudest mic level near when its onset would have been (null if
// no level reports covered it); rejected: an onset there failed the motion gate.
export function logMissed(
  finger: string,
  zone: string | null,
  peak: { level: number; threshold: number } | null,
  rejected: boolean,
) {
  const level = peak ? ` · peak ${fmtDb(peak.level)} vs threshold ${fmtDb(peak.threshold)}` : " · no mic levels";
  appendLog(`missed (no onset): ${where(finger, zone)}${level}${rejected ? " · onset was rejected" : ""}`);
}

// Vision-only taps. latencyMs: from the stop frame's timestamp to the trigger, plus output
// latency; the contact itself came about videoLagMs before that frame.
export function logVisionTap(n: number, finger: string, zone: string | null, latencyMs: number | null) {
  fingerEl.textContent = where(finger, zone);
  if (latencyMs !== null) {
    pushRecent(recentVision, latencyMs);
    const lag = CONFIG.taps.videoLagMs;
    visionLatencyEl.textContent =
      `${latencyMs.toFixed(0)} ms from stop frame, ≈ ${(latencyMs + lag).toFixed(0)} ms from contact · ` +
      `median ${median(recentVision).toFixed(0)} / ≈ ${(median(recentVision) + lag).toFixed(0)} ms ` +
      `(last ${recentVision.length})`;
  }
  const played = latencyMs !== null ? ` · ${latencyMs.toFixed(0)} ms` : " · silent";
  return appendLog(`#${n} vision ${where(finger, zone)}${played}`);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pushRecent(xs: number[], v: number) {
  xs.push(v);
  if (xs.length > CONFIG.taps.medianTaps) xs.shift();
}

// Returns the log line so resolveTap can complete it.
export function logPlayed(t: PlayedTap): HTMLLIElement {
  fingerEl.textContent = t.finger ? where(t.finger, t.zone) : "no finger moving";
  if (t.latencyMs !== null) {
    pushRecent(recentLatencies, t.latencyMs);
    pushRecent(recentWaits, t.waitMs);
    tapLatencyEl.textContent =
      `${t.latencyMs.toFixed(0)} ms (main-thread wait ${t.waitMs.toFixed(0)}, ` +
      `guess+trigger ${t.handlerMs.toFixed(1)})`;
    medianLatencyEl.textContent =
      `${median(recentLatencies).toFixed(0)} ms, wait ${median(recentWaits).toFixed(0)} ms ` +
      `(last ${recentLatencies.length})`;
  }
  const played = t.latencyMs !== null ? ` · ${t.latencyMs.toFixed(0)} ms` : t.finger ? " · silent" : "";
  return appendLog(`#${t.n} ${t.finger ? where(t.finger, t.zone) : "no finger moving"}${played}${notPlayed(t.rejected)}`);
}

// Session accuracy of the instant guess and the stop-based check, one line per finger
// setting, the current one first; target null when the test isn't running.
export function showTest(target: string | null, setting: string, scores: Map<string, TestScore>) {
  testPanelEl.hidden = target === null && scores.size === 0;
  const line = (name: string, s: TestScore) => {
    const pct = (hits: number) => (s.taps ? ` (${((hits / s.taps) * 100).toFixed(0)}%)` : "");
    const div = document.createElement("div");
    div.textContent =
      `${name}: guess ${s.guessHits}/${s.taps}${pct(s.guessHits)} · ` +
      `check ${s.checkHits}/${s.taps}${pct(s.checkHits)}` +
      (s.extraNotes ? ` · ${s.extraNotes} extra notes` : "");
    return div;
  };
  const lines = [line(setting, scores.get(setting) ?? { taps: 0, guessHits: 0, checkHits: 0, extraNotes: 0 })];
  for (const [name, s] of scores) if (name !== setting) lines.push(line(name, s));
  if (target !== null) {
    const tap = document.createElement("div");
    tap.textContent = `Tap ${target}`;
    lines.unshift(tap);
  }
  testStatsEl.replaceChildren(...lines);
}

const fmtMode = (s: MediaTrackSettings) =>
  `${s.width ?? "?"}×${s.height ?? "?"} @ ${s.frameRate ? s.frameRate.toFixed(0) : "?"} fps`;

const fmtAsked = (m: CameraInfo["asked"]) => `${m.width}×${m.height} @ ${m.frameRate}`;

// The mode in use vs what was asked for. measuredFps counts new video frames (null until
// the first second has passed).
// Where the player sits and where that is on screen. detected: from hand pose (else the
// edge nearest the top of the camera image is assumed); samples and agreement: the hand
// frames in the detection window and how well their wrist directions agree (0-1).
export function showPlayer(p: {
  near: Edge;
  left: Edge;
  board: boolean;
  detected: boolean;
  nearSide: string | null;
  leftSide: string | null;
  samples: number;
  agreement: number;
}) {
  if (!p.board) {
    playerEdgeEl.textContent = "no board";
    return;
  }
  const how = p.detected ? "from hands" : "assumed, waiting for hands";
  playerEdgeEl.textContent =
    `near ${p.near} (${p.nearSide}), left ${p.left} (${p.leftSide}) · ${how} · ` +
    `${p.samples} hand frames, agreement ${p.agreement.toFixed(2)}`;
}

// Below camera.lowFpsWarn measured fps, a warning shows under the mic button.
export function showCamera(c: CameraInfo, measuredFps: number | null) {
  const measured = measuredFps === null ? "" : `, measured ${measuredFps.toFixed(0)}`;
  cameraEl.textContent = `${fmtMode(c.settings)}${measured} (asked ${fmtAsked(c.asked)})`;
  const low = measuredFps !== null && measuredFps < CONFIG.camera.lowFpsWarn;
  cameraWarningEl.hidden = !low;
  if (low) cameraWarningEl.textContent = `Camera ${measuredFps.toFixed(0)} fps · low light? camera fps dropped`;
}

// The Probe button's result: running, an error message, or what the probe mode delivered.
export function showProbe(p: CameraProbe | "running" | string) {
  probeEl.textContent =
    p === "running"
      ? "probing…"
      : typeof p === "string"
        ? `failed: ${p}`
        : `asked ${fmtAsked(p.asked)}, got ${fmtMode(p.settings)}, measured ${p.fps.toFixed(0)} fps`;
}

// Hand detection: where it runs, delegate and WebGL renderer, results per second and mean
// detect time, and how "auto" chose (null if it didn't run or hasn't finished).
export function showDetection(
  kind: DetectorKind,
  info: DetectorInfo,
  perSec: number,
  meanMs: number | null,
  choice: string | null,
) {
  const delegate = info.gpuError ? `CPU (GPU failed: ${info.gpuError})` : info.delegate;
  detectionEl.textContent =
    `${kind === "worker" ? "worker" : "main thread"}, ${delegate} on ${info.renderer} · ` +
    `${perSec.toFixed(0)}/s, ${meanMs === null ? "–" : meanMs.toFixed(1)} ms each` +
    (choice ? ` · ${choice}` : "");
}

export type Dropouts = { lost: number[]; frames: number[]; offLost: number; offFrames: number };

// One cell per board column, left to right as the board is defined (C4 first on the
// piano), plus off board: dropouts, and below them dropouts per 1000 frames with a hand
// in that column.
export function showDropouts(d: Dropouts) {
  const cell = (name: string, lost: number, frames: number) => {
    const div = document.createElement("div");
    div.className = "col";
    div.title = `${name}: ${lost} dropouts in ${frames} hand frames`;
    const rate = document.createElement("span");
    rate.textContent = frames ? ((lost / frames) * 1000).toFixed(1) : "–";
    div.append(String(lost), rate);
    return div;
  };
  dropoutsEl.replaceChildren(
    ...d.lost.map((lost, i) => cell(`column ${i + 1}`, lost, d.frames[i])),
    cell("off board", d.offLost, d.offFrames),
  );
}

// Offsets in board coords.
export function showCorrections(c: TapCorrections | null) {
  const signed = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(3)}`;
  const fmt = (name: string, k: Correction | null) =>
    k ? `${name} dx ${signed(k.dx)} dy ${signed(k.dy)}` : `${name} off`;
  tapCorrectionEl.textContent = c ? `${fmt("guess", c.guess)} · ${fmt("check", c.check)}` : "none";
}

// The One Euro sliders: start from the saved values (else CONFIG's), apply each move to
// every filter at once and save it; Defaults goes back to CONFIG's and forgets the saved.
export function initSmoothingControls() {
  loadSmoothing();
  const { sliders } = CONFIG.smoothing;
  const inputs = [
    { input: minCutoffInput, range: sliders.minCutoff, label: el("min-cutoff-value"), unit: " Hz" },
    { input: betaInput, range: sliders.beta, label: el("beta-value"), unit: "" },
  ];
  const show = () => {
    minCutoffInput.value = String(CONFIG.smoothing.minCutoff);
    betaInput.value = String(CONFIG.smoothing.beta);
    for (const { input, label, unit } of inputs) label.textContent = `${input.value}${unit}`;
  };
  for (const { input, range } of inputs) {
    [input.min, input.max, input.step] = range.map(String);
    input.addEventListener("input", () => {
      const p = { minCutoff: Number(minCutoffInput.value), beta: Number(betaInput.value) };
      setSmoothing(p);
      saveSmoothing(p);
      show();
    });
  }
  el("reset-smoothing").addEventListener("click", () => {
    setSmoothing(SMOOTHING_DEFAULTS);
    saveSmoothing(null);
    show();
  });
  show();
}

// One line per hand, fingertips in FINGER_NAMES order: filtered (as drawn) and, in
// brackets, raw RMS spread in camera pixels.
export function showJitter(jitter: Jitter[]) {
  if (jitter.length === 0) {
    jitterEl.textContent = "no hands";
    return;
  }
  const hands = [...new Set(jitter.map((j) => handOf(j.finger)))].sort();
  const lines = hands.map((hand) => {
    const tips = FINGER_NAMES.flatMap((name) => {
      const j = jitter.find((x) => x.finger === fingerKey(hand, name));
      return j ? [`${name} ${j.filtered.toFixed(1)} (${j.raw.toFixed(1)})`] : [];
    });
    return `${hand}: ${tips.join(", ")}`;
  });
  const secs = CONFIG.smoothing.jitterWindowMs / 1000;
  jitterEl.textContent = `px RMS over ${secs} s, filtered (raw)\n${lines.join("\n")}`;
}

// A chord target is a hit only if all its zones played; extra: other zones that played.
export function logTest(line: HTMLLIElement, target: string, hit: { guess: boolean; check: boolean; extra: number }) {
  const mark = (ok: boolean) => (ok ? "✓" : "✗");
  const extra = hit.extra ? ` (+${hit.extra} extra)` : "";
  line.textContent += ` · target ${target}: guess ${mark(hit.guess)}${extra} check ${mark(hit.check)}`;
}

export function resolveTap(line: HTMLLIElement, playedFinger: string | null, r: ResolvedTap) {
  offsetEl.textContent = fmtMs(r.stopOffset);
  if (r.stopOffset !== null) {
    pushRecent(recentOffsets, r.stopOffset);
    medianOffsetEl.textContent = `${fmtMs(median(recentOffsets))} (last ${recentOffsets.length})`;
  }
  const skipped = r.rejected.length ? ` (not counted: ${r.rejected.join("; ")})` : "";
  if (!r.finger) {
    line.textContent += ` · check: no strike stopped${skipped}`;
    return;
  }
  const check = r.finger === playedFinger ? "check ✓" : `check ✗ ${where(r.finger, r.zone)}`;
  const late = r.late ? " (late: guess position)" : "";
  line.textContent += ` · stop ${fmtMs(r.stopOffset)}${late} · ${check}${skipped}`;
}
