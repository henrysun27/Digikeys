import { CONFIG } from "./config.ts";
import type { MicInfo, MicLevel } from "./mic.ts";

const el = (id: string) => document.querySelector<HTMLElement>(`#${id}`)!;
const levelEl = el("mic-level");
const floorEl = el("mic-floor");
const thresholdEl = el("mic-threshold");
const meterLevel = el("meter-level");
const meterThreshold = el("meter-threshold");
const fingerEl = el("chosen-finger");
const offsetEl = el("stop-offset");
const medianEl = el("median-offset");
const latencyEl = el("audio-latency");
const logEl = el("tap-log");
const recentOffsets: number[] = [];

export type TapEntry = {
  n: number;
  finger: string | null;
  zone: string | null;
  stopOffset: number | null;
  guess: string | null; // best-guess finger at onset time, before the stop was seen
};

const db = (v: number) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
const fmtDb = (v: number) => `${Math.max(-99, db(v)).toFixed(0)} dB`;
// Meter spans -80..0 dBFS.
const meterPct = (v: number) => `${Math.min(100, Math.max(0, ((db(v) + 80) / 80) * 100))}%`;
const fmtMs = (ms: number | null) => (ms === null ? "–" : `${ms >= 0 ? "+" : ""}${ms.toFixed(0)} ms`);

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
  latencyEl.textContent =
    `out ${i.outputMs.toFixed(0)} ms applied (raw ${i.outputRawMs.toFixed(1)} ms, ${i.clock}) · ` +
    `in 0 ms applied (stats raw ${raw(i.inputStatsRaw)} ms, settings raw ${raw(i.inputSettingsRaw)} s) · ${rates}`;
}

function appendLog(text: string) {
  const li = document.createElement("li");
  li.textContent = text;
  logEl.prepend(li);
  while (logEl.children.length > CONFIG.taps.logSize) logEl.lastElementChild!.remove();
}

export function logIgnored(n: number, reason: string) {
  appendLog(`#${n} ignored (${reason})`);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function showTap(t: TapEntry) {
  const where = t.finger ? `${t.finger} → ${t.zone ?? "off board"}` : "no finger stopped";
  fingerEl.textContent = where;
  offsetEl.textContent = fmtMs(t.stopOffset);
  if (t.stopOffset !== null) {
    recentOffsets.push(t.stopOffset);
    if (recentOffsets.length > CONFIG.taps.medianTaps) recentOffsets.shift();
    medianEl.textContent = `${fmtMs(median(recentOffsets))} (last ${recentOffsets.length})`;
  }

  const parts = [`#${t.n} ${where}`];
  if (t.finger) {
    parts.push(`stop ${fmtMs(t.stopOffset)}`);
    parts.push(t.guess === t.finger ? "guess ✓" : `guess ✗ ${t.guess ?? "none"}`);
  }
  appendLog(parts.join(" · "));
}
