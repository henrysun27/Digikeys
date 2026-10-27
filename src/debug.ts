import { CONFIG } from "./config.ts";
import type { CameraInfo } from "./main.ts";
import type { MicInfo, MicLevel } from "./mic.ts";
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
const testPanelEl = el("test-panel");
const testStatsEl = el("test-stats");
const tapCorrectionEl = el("tap-correction");
const cameraEl = el("camera-info");
const probeEl = el("camera-probe");
const detectionEl = el("detection");
const dropoutsEl = el("dropouts");
const logEl = el("tap-log");
const recentOffsets: number[] = [];
const recentLatencies: number[] = [];
const recentWaits: number[] = [];

// What was played at onset time from the best-guess finger. waitMs: onset to the main
// thread getting the message; handlerMs: from then to the trigger.
export type PlayedTap = {
  n: number;
  finger: string | null;
  zone: string | null;
  latencyMs: number | null;
  waitMs: number;
  handlerMs: number;
};
// The finger that moved down fastest and then stopped, known once late frames are in.
// late: the stop was past lateStopMs, so zone comes from the guess position.
export type ResolvedTap = { finger: string | null; zone: string | null; stopOffset: number | null; late: boolean };

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
    `out ${i.outputMs.toFixed(0)} ms applied (raw ${i.outputRawMs.toFixed(1)} ms, ${i.clock}) · ` +
    `in 0 ms applied (stats raw ${raw(i.inputStatsRaw)} ms, settings raw ${raw(i.inputSettingsRaw)} s) · ${rates}`;
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
  return appendLog(`#${t.n} ${t.finger ? where(t.finger, t.zone) : "no finger moving"}${played}`);
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
      `check ${s.checkHits}/${s.taps}${pct(s.checkHits)}`;
    return div;
  };
  const lines = [line(setting, scores.get(setting) ?? { taps: 0, guessHits: 0, checkHits: 0 })];
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

// The mode in use vs what was asked for, and how the fast-mode probe went. measuredFps
// counts new video frames (null until the first second has passed).
export function showCamera(c: CameraInfo, measuredFps: number | null) {
  const { width, height, frameRate } = c.asked;
  const measured = measuredFps === null ? "" : `, measured ${measuredFps.toFixed(0)}`;
  cameraEl.textContent = `${fmtMode(c.settings)}${measured} (asked ${width}×${height} @ ${frameRate})`;
  const p = c.probe;
  probeEl.textContent = p
    ? `asked ${p.asked.width}×${p.asked.height} @ ${p.asked.frameRate}, got ${fmtMode(p.settings)}, ` +
      `measured ${p.fps.toFixed(0)} fps: ${p.used ? "used" : `not used (needs > ${CONFIG.camera.fastMinFps})`}`
    : "off";
}

// Hand detection in the worker: results per second and mean detect time.
export function showDetection(perSec: number, meanMs: number | null) {
  detectionEl.textContent = `${perSec.toFixed(0)}/s, ${meanMs === null ? "–" : meanMs.toFixed(1)} ms each (worker)`;
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

export function logTest(line: HTMLLIElement, target: string, hit: { guess: boolean; check: boolean }) {
  const mark = (ok: boolean) => (ok ? "✓" : "✗");
  line.textContent += ` · target ${target}: guess ${mark(hit.guess)} check ${mark(hit.check)}`;
}

export function resolveTap(line: HTMLLIElement, playedFinger: string | null, r: ResolvedTap) {
  offsetEl.textContent = fmtMs(r.stopOffset);
  if (r.stopOffset !== null) {
    pushRecent(recentOffsets, r.stopOffset);
    medianOffsetEl.textContent = `${fmtMs(median(recentOffsets))} (last ${recentOffsets.length})`;
  }
  if (!r.finger) {
    line.textContent += " · no finger stopped";
    return;
  }
  const check = r.finger === playedFinger ? "check ✓" : `check ✗ ${where(r.finger, r.zone)}`;
  const late = r.late ? " (late: guess position)" : "";
  line.textContent += ` · stop ${fmtMs(r.stopOffset)}${late} · ${check}`;
}
