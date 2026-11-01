// The Debug panel's "Export session": every onset since the page loaded with its full
// decision (mic rise per band, each candidate finger's stroke, landing point, score and
// shadow vote, the zones played, the stop-based check, the Test-mode target and result,
// latency), vision-only taps, missed taps, and a once-a-second timeline of camera fps and
// detection timing. Saved by the server to the repo's sessions/ folder (gitignored).
// Times are ms since the page loaded (performance.now()), board points 0-1, camera
// points 0-1 of the frame.
import { CONFIG } from "./config.ts";
import type { BandReading } from "./band-rise.ts";
import type { StepRow } from "./frame-steps.ts";
import type { Pt } from "./geometry.ts";
import type { Zone } from "./layout.ts";
import type { Onset } from "./mic.ts";
import type { ShadowVote } from "./shadow-contact.ts";
import type { FingerPick, StopWindow } from "./taps.ts";

const db = (ratio: number) => (ratio > 0 && Number.isFinite(ratio) ? 20 * Math.log10(ratio) : null);
const round = (v: number, k = 4) => Math.round(v * 10 ** k) / 10 ** k;
const pt = (p: Pt | null, k = 4) => (p ? { x: round(p.x, k), y: round(p.y, k) } : null);
const ms = (v: number | null) => (v === null ? null : round(v, 2));

export type Candidate = {
  finger: string;
  // The stroke from its first frame to its stop (or, for a still-moving guess, to where
  // it is extrapolated to land at onset + videoLagMs): board units and board units/s.
  stroke: { startT: number; endT: number; depth: number; speed: number; stopped: boolean };
  stopOffsetMs: number | null; // stop frame minus onset + videoLagMs; null while moving
  landing: { cam: Pt | null; board: Pt | null; zone: string | null }; // board: tap correction applied
  score: number; // after the shadow vote, if any
  strike: boolean;
  why: string | null; // why it is no strike, with the measured value
  inChord: boolean;
  notChosen: string[]; // why a strike was left out (off board, below chordRatio, refractory)
  played: boolean;
  late?: boolean; // check only: stop past lateStopMs, so landing is its guess position
  shadowVote: ShadowVote | null; // fused mode only
};

export type DecisionNote = { pick: FingerPick; at: Pt | null; zone: Zone | null; late?: boolean };

export type OnsetRecord = {
  n: number | null; // the tap log's number, null for onsets the log doesn't number
  source: "mic" | "vision";
  t: number; // onset (mic) or stop frame (vision) time
  outcome: string;
  mode: string;
  fingersAllowed: string[];
  handsInFrame: number;
  frameMs: number | null;
  stopWindow: StopWindow | null;
  mic: {
    ctxTime: number;
    receivedAt: number;
    waitMs: number; // main-thread wait for the onset message
    level: number;
    levelDb: number | null;
    threshold: number;
    thresholdDb: number | null;
    rise: number | null;
    riseDb: number | null;
    // rise null: the band's baseline was silent.
    bands: { name: string; hz: [number, number]; level: number; levelDb: number | null; rise: number | null; riseDb: number | null }[];
  } | null;
  guess: { candidates: Candidate[]; chord: string[] } | null;
  played: { finger: string; zone: string; label: string; at: Pt | null; latencyMs: number | null }[];
  latencyMs: number | null; // first note: (sound ctxTime - onset ctxTime) * 1000 + output latency
  handlerMs: number | null; // guess + trigger on the main thread
  check: {
    candidates: Candidate[];
    chord: string[];
    zones: string[];
    stopOffsetMs: number | null;
    late: boolean;
    agrees: boolean; // same zones as played
    hovering: { judged: string[]; hovering: string[] } | null;
  } | null;
  test: { target: string; zones: string[]; opened: boolean; result: { guess: boolean; check: boolean; extra: number } | null } | null;
  tapCalibration: { target: string } | null;
};

export type MissRecord = { t: number; finger: string; zone: string | null; peak: { level: number; threshold: number } | null; onsetRejected: boolean };

export type SecondRecord = {
  t: number;
  cameraFps: number;
  detectionsPerSec: number;
  detectMeanMs: number | null;
  drawsPerSec: number;
  handsInFrame: number;
  steps: StepRow[];
};

// A test attempt (test-mode.ts Attempt), only used as a key.
type AttemptKey = object;

export class SessionLog {
  readonly startedAt = new Date().toISOString();
  readonly onsets: OnsetRecord[] = [];
  readonly misses: MissRecord[] = [];
  readonly seconds: SecondRecord[] = [];
  dropped = 0;
  private attempts = new Map<AttemptKey, OnsetRecord[]>();

  private keep<T>(xs: T[], x: T) {
    xs.push(x);
    if (xs.length > CONFIG.session.maxRecords) {
      xs.shift();
      this.dropped++;
    }
  }

  // A record with the onset's mic readings and the state taps were judged in.
  onset(
    n: number | null,
    o: Onset,
    outcome: string,
    s: { mode: string; handsInFrame: number; frameMs: number | null; stopWindow: StopWindow | null },
  ): OnsetRecord {
    const r: OnsetRecord = {
      n,
      source: "mic",
      t: ms(o.time)!,
      outcome,
      mode: s.mode,
      fingersAllowed: [...CONFIG.fingers.allowed],
      handsInFrame: s.handsInFrame,
      frameMs: ms(s.frameMs),
      stopWindow: s.stopWindow,
      mic: {
        ctxTime: o.ctxTime,
        receivedAt: ms(o.receivedAt)!,
        waitMs: ms(o.receivedAt - o.time)!,
        level: o.level,
        levelDb: ms(db(o.level)),
        threshold: o.threshold,
        thresholdDb: ms(db(o.threshold)),
        rise: Number.isFinite(o.rise) ? o.rise : null,
        riseDb: ms(db(o.rise)),
        bands: o.bands.map((b: BandReading, k) => ({
          name: b.name,
          hz: CONFIG.onset.bands[k]?.hz ?? [0, 0],
          level: b.level,
          levelDb: ms(db(b.level)),
          rise: Number.isFinite(b.rise) ? b.rise : null,
          riseDb: ms(db(b.rise)),
        })),
      },
      guess: null,
      played: [],
      latencyMs: null,
      handlerMs: null,
      check: null,
      test: null,
      tapCalibration: null,
    };
    this.keep(this.onsets, r);
    return r;
  }

  vision(n: number, pick: FingerPick, s: { mode: string; handsInFrame: number; frameMs: number | null }): OnsetRecord {
    const r: OnsetRecord = {
      n,
      source: "vision",
      t: ms(pick.at.t)!,
      outcome: "silent",
      mode: s.mode,
      fingersAllowed: [...CONFIG.fingers.allowed],
      handsInFrame: s.handsInFrame,
      frameMs: ms(s.frameMs),
      stopWindow: null,
      mic: null,
      guess: null,
      played: [],
      latencyMs: null,
      handlerMs: null,
      check: null,
      test: null,
      tapCalibration: null,
    };
    this.keep(this.onsets, r);
    return r;
  }

  miss(m: MissRecord) {
    this.keep(this.misses, { ...m, t: ms(m.t)! });
  }

  second(s: SecondRecord) {
    this.keep(this.seconds, s);
  }

  // Every finger judged for one decision. expected: onset + videoLagMs.
  candidates(
    notes: DecisionNote[],
    chord: DecisionNote[],
    rejected: string[],
    votes: ShadowVote[],
    playedFingers: string[],
    expected: number | null,
  ): Candidate[] {
    const inChord = new Set(chord.map((c) => c.pick.finger));
    const vote = new Map(votes.map((v) => [v.finger, v]));
    return notes.map(({ pick, at, zone, late }) => ({
      finger: pick.finger,
      stroke: {
        startT: ms(pick.startT)!,
        endT: ms(pick.at.t)!,
        depth: round(pick.depth),
        speed: round(pick.speed),
        stopped: pick.stopped,
      },
      stopOffsetMs: ms(pick.stopOffset ?? (pick.stopped && expected !== null ? pick.at.t - expected : null)),
      landing: { cam: pt({ x: pick.at.fx, y: pick.at.fy }), board: pt(at), zone: zone?.label ?? null },
      score: round(pick.score),
      strike: pick.why === null,
      why: pick.why,
      inChord: inChord.has(pick.finger),
      notChosen: rejected
        .filter((r) => r.startsWith(`${pick.finger} `))
        .map((r) => r.slice(pick.finger.length + 1))
        .filter((r) => r !== pick.why),
      played: playedFingers.includes(pick.finger),
      ...(late === undefined ? {} : { late }),
      shadowVote: vote.get(pick.finger) ?? null,
    }));
  }

  // The test attempt this record's tap joined; its result is filled in when it is scored.
  joinAttempt(r: OnsetRecord, attempt: AttemptKey, target: { label: string; zones: Zone[] }, opened: boolean) {
    r.test = { target: target.label, zones: target.zones.map((z) => z.label), opened, result: null };
    let rs = this.attempts.get(attempt);
    if (!rs) this.attempts.set(attempt, (rs = []));
    rs.push(r);
  }

  attemptScored(attempt: AttemptKey, result: { guess: boolean; check: boolean; extra: number }) {
    for (const r of this.attempts.get(attempt) ?? []) if (r.test) r.test.result = { ...result };
    this.attempts.delete(attempt);
  }

  // The whole session, with whatever context the caller adds (config, camera, layout...).
  export(context: Record<string, unknown>) {
    const mic = this.onsets.filter((r) => r.source === "mic");
    const lat = this.onsets.flatMap((r) => (r.latencyMs === null ? [] : [r.latencyMs])).sort((a, b) => a - b);
    const q = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * (lat.length - 1)))] : null);
    const scored = this.onsets.filter((r) => r.test?.opened && r.test.result);
    return {
      kind: "digikeys-session",
      version: 1,
      startedAt: this.startedAt,
      exportedAt: new Date().toISOString(),
      durationMs: round(performance.now(), 0),
      summary: {
        onsets: mic.length,
        played: mic.filter((r) => r.played.length > 0).length,
        rejected: mic.filter((r) => r.outcome === "rejected").length,
        ignored: mic.filter((r) => r.outcome.startsWith("ignored")).length,
        visionTaps: this.onsets.length - mic.length,
        missed: this.misses.length,
        checkAgrees: this.onsets.filter((r) => r.check?.agrees).length,
        checked: this.onsets.filter((r) => r.check).length,
        testAttempts: scored.length,
        testGuessHits: scored.filter((r) => r.test!.result!.guess).length,
        testCheckHits: scored.filter((r) => r.test!.result!.check).length,
        latencyMs: { median: q(0.5), p95: q(0.95), n: lat.length },
        droppedRecords: this.dropped,
      },
      ...context,
      onsets: this.onsets,
      misses: this.misses,
      timeline: this.seconds,
    };
  }
}
