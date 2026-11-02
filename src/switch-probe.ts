// Numbers around a voice instrument switch: the windowMs before the talk press, from the
// press until the switch ends (layout built, or the request failed), and the windowMs after
// it. Each finished switch goes to the Debug log and the session export (voiceSwitches).
// Times are performance.now() ms.
import { CONFIG } from "./config.ts";

export type MicSettings = {
  echoCancellation: boolean | string | null; // the spec also allows "all" and "remote-only"
  noiseSuppression: boolean | null;
  autoGainControl: boolean | null;
  sampleRate: number | null; // the track's
  ctxRate: number | null; // the AudioContext's
  readyState: string | null;
};

// Main-thread work of one step. syncMs: the longest stretch it held the thread. totalMs: start
// to finish, including what ran off the thread.
export type ProbeSpan = { name: string; syncMs: number; totalMs: number };

export type JitterReading = { finger: string; raw: number; filtered: number };

type Percentiles = { n: number; median: number | null; p95: number | null; max: number | null; overFrame: number };

export type SwitchWindow = {
  seconds: number;
  cameraFps: number;
  maxFrameGapMs: number | null; // the longest wait between two video frames
  detectionFps: number;
  handFrameShare: number | null; // detections with at least one hand
  dropouts: number; // hands present in one detection and gone in the next
  jitterPx: { raw: number | null; filtered: number | null }; // median of the index tips' 1 s RMS
  detectMs: { mean: number | null; max: number | null };
  workerWaitMs: Percentiles; // a frame waiting for the worker to take it
  mainWaitMs: Percentiles; // a mic level report waiting for the main thread
  mainStalls: { worst: number | null; overFrame: number }; // heartbeat gaps past its interval
  drawMs: { mean: number | null; max: number | null };
  stageResizes: number; // the instrument changed size on screen
  onsets: { count: number; perSecond: number; notes: number };
  pageHidden: boolean; // rates mean little if the tab was in the background
};

export type SwitchReport = {
  n: number;
  t: number; // the press
  outcome: string;
  instrument: string;
  windows: { before: SwitchWindow; during: SwitchWindow; after: SwitchWindow | null };
  spans: ProbeSpan[];
  mic: { at: string; settings: MicSettings | null }[];
  micRaw: boolean | null; // all three voice-processing settings stayed false; null: mic off
  layoutChange: { fingersCleared: number; refractoriesCleared: number; handTracks: number; calibrated: boolean } | null;
};

type Detection = { t: number; detectMs: number; sendMs: number | null; hands: number };
type Timed = { t: number; ms: number };
type Jitter = { t: number; raw: number; filtered: number };

const FRAME_MS = () => 1000 / CONFIG.camera.mode.frameRate;

function percentiles(xs: number[]): Percentiles {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] : null);
  const frame = FRAME_MS();
  return { n: s.length, median: at(0.5), p95: at(0.95), max: at(1), overFrame: s.filter((v) => v > frame).length };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : null;
};

export class SwitchProbe {
  readonly reports: SwitchReport[] = [];
  onReport: (r: SwitchReport) => void = () => {};

  private frames: number[] = [];
  private detections: Detection[] = [];
  private lostHands: number[] = [];
  private jitters: Jitter[] = [];
  private waits: Timed[] = [];
  private stalls: Timed[] = [];
  private draws: Timed[] = [];
  private onsets: number[] = [];
  private notes: number[] = [];
  private resizes: number[] = [];
  private hiddenAt: number[] = [];

  // The switch being measured. endedAt: the "after" window started.
  private open: {
    t: number;
    endedAt: number | null;
    outcome: string;
    instrument: string;
    spans: ProbeSpan[];
    mic: { at: string; settings: MicSettings | null }[];
    layoutChange: SwitchReport["layoutChange"];
  } | null = null;

  // Measures how long the main thread was held between heartbeats.
  start() {
    const { heartbeatMs, minStallMs } = CONFIG.voiceProbe;
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      if (document.hidden) this.hiddenAt.push(now);
      else if (now - last - heartbeatMs >= minStallMs) this.stalls.push({ t: now, ms: now - last - heartbeatMs });
      last = now;
    }, heartbeatMs);
  }

  frame(t: number) {
    this.frames.push(t);
  }
  detection(t: number, detectMs: number, sendMs: number | null, hands: number) {
    this.detections.push({ t, detectMs, sendMs, hands });
  }
  lost(t: number, n: number) {
    for (let i = 0; i < n; i++) this.lostHands.push(t);
  }
  jitter(t: number, readings: JitterReading[]) {
    for (const r of readings) if (r.finger.endsWith(" index")) this.jitters.push({ t, raw: r.raw, filtered: r.filtered });
  }
  wait(t: number, ms: number) {
    this.waits.push({ t, ms });
  }
  draw(t: number, ms: number) {
    this.draws.push({ t, ms });
  }
  onset(t: number) {
    this.onsets.push(t);
  }
  note(t: number) {
    this.notes.push(t);
  }
  resize(t: number) {
    this.resizes.push(t);
  }

  get measuring() {
    return this.open !== null && this.open.endedAt === null;
  }

  // The talk press. A switch still in its "after" window is finished early.
  begin(mic: MicSettings | null) {
    if (this.open) this.finish(performance.now());
    this.open = { t: performance.now(), endedAt: null, outcome: "", instrument: "", spans: [], mic: [{ at: "before press", settings: mic }], layoutChange: null };
  }

  span(name: string, syncMs: number, totalMs = syncMs) {
    this.open?.spans.push({ name, syncMs, totalMs });
  }

  mic(at: string, settings: MicSettings | null) {
    this.open?.mic.push({ at, settings });
  }

  layoutChanged(change: NonNullable<SwitchReport["layoutChange"]>) {
    if (this.open) this.open.layoutChange = change;
  }

  end(outcome: string, instrument: string, mic: MicSettings | null) {
    if (!this.open || this.open.endedAt !== null) return;
    this.open.endedAt = performance.now();
    this.open.outcome = outcome;
    this.open.instrument = instrument;
    this.mic("switch ended", mic);
  }

  // Call about once a second: finishes a switch whose "after" window is over, and drops
  // samples no window can need any more.
  tick(now: number, mic: () => MicSettings | null) {
    const { windowMs } = CONFIG.voiceProbe;
    if (this.open?.endedAt != null && now - this.open.endedAt >= windowMs) {
      this.mic(`${windowMs / 1000} s after`, mic());
      this.finish(now);
    }
    const keepFrom = (this.open?.t ?? now) - windowMs;
    const trim = <T>(xs: T[], t: (x: T) => number) => {
      let k = 0;
      while (k < xs.length && t(xs[k]) < keepFrom) k++;
      if (k) xs.splice(0, k);
    };
    trim(this.frames, (t) => t);
    trim(this.detections, (d) => d.t);
    trim(this.lostHands, (t) => t);
    trim(this.jitters, (j) => j.t);
    trim(this.waits, (w) => w.t);
    trim(this.stalls, (s) => s.t);
    trim(this.draws, (d) => d.t);
    trim(this.onsets, (t) => t);
    trim(this.notes, (t) => t);
    trim(this.resizes, (t) => t);
    trim(this.hiddenAt, (t) => t);
  }

  private window(from: number, to: number): SwitchWindow {
    const inT = (t: number) => t >= from && t < to;
    const secs = Math.max(0.001, (to - from) / 1000);
    const frame = FRAME_MS();
    const dets = this.detections.filter((d) => inT(d.t));
    const jit = this.jitters.filter((j) => inT(j.t));
    const stalls = this.stalls.filter((s) => inT(s.t)).map((s) => s.ms);
    const draws = this.draws.filter((d) => inT(d.t)).map((d) => d.ms);
    const onsets = this.onsets.filter(inT).length;
    const frames = this.frames.filter(inT);
    return {
      seconds: secs,
      cameraFps: frames.length / secs,
      maxFrameGapMs: frames.length > 1 ? Math.max(...frames.slice(1).map((t, i) => t - frames[i])) : null,
      detectionFps: dets.length / secs,
      handFrameShare: dets.length ? dets.filter((d) => d.hands > 0).length / dets.length : null,
      dropouts: this.lostHands.filter(inT).length,
      jitterPx: { raw: median(jit.map((j) => j.raw)), filtered: median(jit.map((j) => j.filtered)) },
      detectMs: { mean: mean(dets.map((d) => d.detectMs)), max: dets.length ? Math.max(...dets.map((d) => d.detectMs)) : null },
      workerWaitMs: percentiles(dets.flatMap((d) => (d.sendMs === null ? [] : [d.sendMs]))),
      mainWaitMs: percentiles(this.waits.filter((w) => inT(w.t)).map((w) => w.ms)),
      mainStalls: { worst: stalls.length ? Math.max(...stalls) : null, overFrame: stalls.filter((s) => s > frame).length },
      drawMs: { mean: mean(draws), max: draws.length ? Math.max(...draws) : null },
      stageResizes: this.resizes.filter(inT).length,
      onsets: { count: onsets, perSecond: onsets / secs, notes: this.notes.filter(inT).length },
      pageHidden: this.hiddenAt.some(inT),
    };
  }

  private finish(now: number) {
    const k = this.open!;
    this.open = null;
    const { windowMs } = CONFIG.voiceProbe;
    const ended = k.endedAt ?? now;
    const settings = k.mic.flatMap((m) => (m.settings ? [m.settings] : []));
    const report: SwitchReport = {
      n: this.reports.length + 1,
      t: k.t,
      outcome: k.outcome || "interrupted by another press",
      instrument: k.instrument,
      windows: {
        before: this.window(k.t - windowMs, k.t),
        during: this.window(k.t, ended),
        after: k.endedAt === null ? null : this.window(ended, Math.min(now, ended + windowMs)),
      },
      spans: k.spans,
      mic: k.mic,
      micRaw: settings.length
        ? settings.every((s) => s.echoCancellation === false && s.noiseSuppression === false && s.autoGainControl === false)
        : null,
      layoutChange: k.layoutChange,
    };
    this.reports.push(report);
    this.onReport(report);
  }
}

// One line for the Debug log.
export function switchSummary(r: SwitchReport): string {
  const { before: b, during: d, after: a } = r.windows;
  const f = (v: number | null | undefined, k = 0) => (v === null || v === undefined ? "–" : v.toFixed(k));
  const three = (pick: (w: SwitchWindow) => string) => `${pick(b)} / ${pick(d)} / ${a ? pick(a) : "–"}`;
  const worst = r.spans.reduce<ProbeSpan | null>((m, s) => (!m || s.syncMs > m.syncMs ? s : m), null);
  return (
    `voice switch #${r.n} (before / during / after): ` +
    `detection ${three((w) => f(w.detectionFps))}/s, ` +
    `longest frame gap ${three((w) => f(w.maxFrameGapMs))} ms, ` +
    `dropouts ${three((w) => String(w.dropouts))}, ` +
    `stage resizes ${three((w) => String(w.stageResizes))}, ` +
    `jitter ${three((w) => f(w.jitterPx.filtered, 1))} px, ` +
    `main wait p95 ${three((w) => f(w.mainWaitMs.p95))} ms, ` +
    `onsets ${three((w) => f(w.onsets.perSecond, 1))}/s, ` +
    `mic ${r.micRaw === null ? "off" : r.micRaw ? "raw" : "PROCESSING ON"}` +
    (worst ? `, longest step ${worst.name} ${f(worst.syncMs)} ms` : "")
  );
}
