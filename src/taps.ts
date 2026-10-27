import { CONFIG } from "./config.ts";
import type { Pt } from "./geometry.ts";

export const FINGERTIPS = [4, 8, 12, 16, 20];
export const FINGER_NAMES = ["thumb", "index", "middle", "ring", "pinky"];

// Fingers are keyed "<hand> <finger>", e.g. "A index", where the hand is its tracking ID.
export const fingerKey = (hand: string, finger: string) => `${hand} ${finger}`;
export const handOf = (key: string) => key.slice(0, key.lastIndexOf(" "));
const fingerOf = (key: string) => key.slice(key.lastIndexOf(" ") + 1);
export const isAllowed = (key: string) => CONFIG.fingers.allowed.includes(fingerOf(key));

// t is when the frame's landmarks were detected, performance.now() ms. x, y are raw
// camera coords (0-1), for motion: smoothing would blunt down-strokes. fx, fy are the One
// Euro filtered position, for where a tap lands.
export type Sample = { t: number; x: number; y: number; fx: number; fy: number };

export const landing = (s: Sample): Pt => ({ x: s.fx, y: s.fy });

// s moved by (dx, dy), raw and filtered alike.
const shifted = (s: Sample, t: number, dx: number, dy: number): Sample => ({
  t,
  x: s.x + dx,
  y: s.y + dy,
  fx: s.fx + dx,
  fy: s.fy + dy,
});

// Board coords of a camera point, or null without a calibrated board.
export type ToBoard = (p: Pt) => Pt | null;

// A finger's down-stroke judged as a strike. It counts only if it went down the board at
// least CONFIG.taps.minStrokeDepth (board units, start to end) at a mean speed of at least
// minStrikeSpeed (board units/s) and stopped. at: where it stopped, or for the instant
// guess, where a still-moving stroke should land (the onset stands in for the stop, whose
// frames haven't arrived yet). why: null for a strike, else the reason with the measured
// value. score ranks strikes for chords: weighted depth for the guess, speed for the check.
export type FingerPick = {
  finger: string;
  depth: number;
  speed: number;
  at: Sample;
  stopped: boolean;
  why: string | null;
  score: number;
  stopOffset: number | null; // stop time minus expected stop time (onset + videoLagMs), ms
};

// What the guess knows besides finger motion: board mapping, whether a camera point is on
// the board, and the hand of the last tap if it was recent.
export type GuessContext = { toBoard: ToBoard; onBoard: (p: Pt) => boolean; lastHand: string | null };

// start: the frame the stroke started from. prev is the frame before last, for
// extrapolating a stroke that is still moving.
type Stroke = { peak: number; start: Sample; stop: Sample | null; last: Sample; prev: Sample | null };

const raw = (s: Sample): Pt => ({ x: s.x, y: s.y });

// Depth and mean speed of a stroke from start to `at`, in board units, and whether that
// makes a strike.
function judge(finger: string, start: Sample, at: Sample, stopped: boolean, toBoard: ToBoard): FingerPick {
  const { minStrokeDepth, minStrikeSpeed } = CONFIG.taps;
  const a = toBoard(raw(start));
  const b = toBoard(raw(at));
  const depth = a && b ? b.y - a.y : 0;
  const dt = at.t - start.t;
  const speed = dt > 0 ? (depth / dt) * 1000 : 0;
  // A still-moving stroke is measured to its extrapolated landing: say so in the reason.
  const est = stopped ? "" : " predicted";
  const why =
    !a || !b
      ? "no board"
      : depth < minStrokeDepth
        ? `too shallow (${depth.toFixed(3)}${est} < ${minStrokeDepth})`
        : speed < minStrikeSpeed
          ? `too slow (${speed.toFixed(2)}/s${est} < ${minStrikeSpeed}/s)`
          : null;
  return { finger, depth, speed, at, stopped, why, score: 0, stopOffset: null };
}

// Strikes first, best score first; then the rest.
const ranked = (picks: FingerPick[]) =>
  picks.sort((a, b) => Number(a.why !== null) - Number(b.why !== null) || b.score - a.score);

export class FingerHistory {
  private tracks = new Map<string, Sample[]>();
  private reported = new Map<string, number>(); // finger -> time of its last stop from newStops

  add(finger: string, s: Sample) {
    let track = this.tracks.get(finger);
    if (!track) this.tracks.set(finger, (track = []));
    track.push(s);
    while (track.length && track[0].t < s.t - CONFIG.taps.keepMs) track.shift();
  }

  // Forgets a hand's fingers, when its ID passes to a different hand.
  dropHand(hand: string) {
    for (const finger of this.tracks.keys()) {
      if (handOf(finger) !== hand) continue;
      this.tracks.delete(finger);
      this.reported.delete(finger);
    }
  }

  // Strikes that stopped inside the board since the last call, each stroke reported once.
  // Call after every frame's samples are added.
  newStops(toBoard: ToBoard, onBoard: (p: Pt) => boolean): FingerPick[] {
    const out: FingerPick[] = [];
    for (const [finger, track] of this.tracks) {
      if (!isAllowed(finger) || track.length < 2) continue;
      const from = track[track.length - 1].t - CONFIG.taps.historyMs;
      const after = this.reported.get(finger) ?? -Infinity;
      for (const k of downStrokes(track.filter((s) => s.t >= from))) {
        if (!k.stop || k.stop.t <= after) continue;
        this.reported.set(finger, k.stop.t);
        const m = judge(finger, k.start, k.stop, true, toBoard);
        if (!m.why && onBoard(landing(m.at))) out.push(m);
      }
    }
    return out;
  }

  // Every allowed finger with a stop around the onset, judged as a strike and scored by
  // speed (the fastest strike first). A finger landing at the onset shows up in frames
  // videoLagMs later, so the search is centered there: the stop must be within
  // stopToleranceMs of it (per finger, the stroke stopping closest to it). Needs frames up
  // to that time, so call it after they're in.
  resolveAll(onset: number, toBoard: ToBoard): FingerPick[] {
    const { historyMs, stopToleranceMs, videoLagMs } = CONFIG.taps;
    const expected = onset + videoLagMs;
    const from = expected - stopToleranceMs - historyMs;
    const to = expected + stopToleranceMs;
    const picks: FingerPick[] = [];
    for (const [finger, track] of this.tracks) {
      if (!isAllowed(finger)) continue;
      const strokes = downStrokes(track.filter((s) => s.t >= from && s.t <= to));
      const stroke = nearestStop(
        strokes.filter((k) => k.stop && Math.abs(k.stop.t - expected) <= stopToleranceMs),
        expected,
      );
      if (!stroke) continue;
      const m = judge(finger, stroke.start, stroke.stop!, true, toBoard);
      picks.push({ ...m, score: m.speed, stopOffset: m.at.t - expected });
    }
    return ranked(picks);
  }

  // Best guess at onset time, from the frames so far: every allowed finger with a
  // down-stroke in the window, judged on its latest stroke. That is its stop if already
  // seen (not older than stopToleranceMs before the expected stop), or, with webcam lag
  // usually, the stroke still coming down, extrapolated to where it should land. Strikes
  // are scored by depth weighted by CONFIG.guess: thumbs count less unless they strike
  // deep, and fingers already on the board or on the hand that tapped last count more.
  guessAll(onset: number, c: GuessContext): FingerPick[] {
    const { historyMs, stopToleranceMs, videoLagMs } = CONFIG.taps;
    const g = CONFIG.guess;
    const expected = onset + videoLagMs;
    const from = expected - stopToleranceMs - historyMs;
    const picks: FingerPick[] = [];
    for (const [finger, track] of this.tracks) {
      if (!isAllowed(finger)) continue;
      const s = track.filter((p) => p.t >= from);
      const stroke = downStrokes(s).at(-1);
      if (!stroke) continue;
      const at = stroke.stop ?? extrapolate(stroke, expected);
      const m = judge(finger, stroke.start, at, !!stroke.stop, c.toBoard);
      if (!m.why && stroke.stop && stroke.stop.t < expected - stopToleranceMs) {
        m.why = `stopped too early (${(stroke.stop.t - expected).toFixed(0)} ms)`;
      }
      let score = m.depth;
      if (fingerOf(finger) === "thumb" && m.depth < g.thumbStrikeDepth) score *= g.thumbWeight;
      if (c.onBoard(landing(s[s.length - 1]))) score *= g.onBoardWeight;
      if (c.lastHand !== null && handOf(finger) === c.lastHand) score *= g.lastHandWeight;
      picks.push({ ...m, score });
    }
    return ranked(picks);
  }
}

// Downward (increasing y) strokes in order, in camera coords. A stroke starts when speed
// reaches motion.minDownSpeed (low on purpose: judge decides in board units whether it is
// a strike) and stops at the last frame before speed falls below stopSpeedRatio of its
// peak. The final stroke may still be moving (stop null).
function downStrokes(s: Sample[]): Stroke[] {
  const { minDownSpeed } = CONFIG.motion;
  const { stopSpeedRatio } = CONFIG.taps;
  const strokes: Stroke[] = [];
  let peak = 0;
  let start = s[0];
  for (let i = 1; i < s.length; i++) {
    const v = speed(s[i - 1], s[i]);
    if (peak === 0) {
      if (v >= minDownSpeed) {
        peak = v;
        start = s[i - 1];
      }
    } else if (v > peak) {
      peak = v;
    } else if (v <= peak * stopSpeedRatio) {
      strokes.push({ peak, start, stop: s[i - 1], last: s[i - 1], prev: null });
      peak = 0;
    }
  }
  if (peak > 0) strokes.push({ peak, start, stop: null, last: s[s.length - 1], prev: s[s.length - 2] });
  return strokes;
}

// Where a still-moving finger will be when its contact shows up in frames (time t),
// continuing its last frame-to-frame motion for at most maxExtrapolateMs.
function extrapolate(k: Stroke, t: number): Sample {
  const { last, prev } = k;
  if (!prev || last.t <= prev.t) return last;
  const dt = Math.min(Math.max(0, t - last.t), CONFIG.taps.maxExtrapolateMs);
  const f = dt / (last.t - prev.t);
  return shifted(last, last.t + dt, (last.x - prev.x) * f, (last.y - prev.y) * f);
}

function nearestStop(strokes: Stroke[], expected: number): Stroke | undefined {
  let best: Stroke | undefined;
  for (const k of strokes) {
    if (!best || Math.abs(k.stop!.t - expected) < Math.abs(best.stop!.t - expected)) best = k;
  }
  return best;
}

function speed(a: Sample, b: Sample): number {
  const dt = b.t - a.t;
  return dt > 0 ? ((b.y - a.y) / dt) * 1000 : 0;
}
