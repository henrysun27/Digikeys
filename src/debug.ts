import { CONFIG } from "./config.ts";
import type { MicLevel } from "./mic.ts";

const el = (id: string) => document.querySelector<HTMLElement>(`#${id}`)!;
const levelEl = el("mic-level");
const floorEl = el("mic-floor");
const thresholdEl = el("mic-threshold");
const meterLevel = el("meter-level");
const meterThreshold = el("meter-threshold");
const fingerEl = el("chosen-finger");
const offsetEl = el("stop-offset");
const logEl = el("tap-log");

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

export function showTap(t: TapEntry) {
  const where = t.finger ? `${t.finger} → ${t.zone ?? "off board"}` : "no finger stopped";
  fingerEl.textContent = where;
  offsetEl.textContent = fmtMs(t.stopOffset);

  const parts = [`#${t.n} ${where}`];
  if (t.finger) {
    parts.push(`stop ${fmtMs(t.stopOffset)}`);
    parts.push(t.guess === t.finger ? "guess ✓" : `guess ✗ ${t.guess ?? "none"}`);
  }
  const li = document.createElement("li");
  li.textContent = parts.join(" · ");
  logEl.prepend(li);
  while (logEl.children.length > CONFIG.taps.logSize) logEl.lastElementChild!.remove();
}
