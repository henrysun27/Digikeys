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

// score: what fingers are ranked by (weighted travel for the guess, peak speed for the
// check), so chord members can be compared with the best.
export type FingerPick = {
  finger: string;
  score: number;
  peakSpeed: number; // frame heights per second, downward
  at: Sample; // where the finger stopped, or where it should land if still moving
  stopOffset: number | null; // stop time minus expected stop time (onset + videoLagMs), ms
};

// What the guess knows besides finger motion: whether a camera point is on the board, and
// the hand of the last tap if it was recent.
export type GuessContext = { onBoard: (p: Pt) => boolean; lastHand: string | null };

// start: the frame the stroke started from. prev is the frame before last, for
// extrapolating a stroke that is still moving.
type Stroke = { peak: number; start: Sample; stop: Sample | null; last: Sample; prev: Sample | null };

// A down-stroke of one finger for the hybrid gate, vision taps and miss logging. end is
// where it stopped, or its latest frame if still moving; travel is in frame heights.
export type Motion = { finger: string; peak: number; travel: number; end: Sample; stopped: boolean };

function toMotion(finger: string, k: Stroke): Motion {
  const end = k.stop ?? k.last;
  return { finger, peak: k.peak, travel: end.y - k.start.y, end, stopped: k.stop !== null };
}

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

  // Allowed fingers' down-strokes in frames since `from` that descended at least
  // CONFIG.motion.minTravel and end (stopped or still moving) inside the board.
  motionSince(from: number, onBoard: (p: Pt) => boolean): Motion[] {
    const { minDownSpeed, minTravel } = CONFIG.motion;
    const out: Motion[] = [];
    for (const [finger, track] of this.tracks) {
      if (!isAllowed(finger)) continue;
      for (const k of downStrokes(track.filter((s) => s.t >= from), minDownSpeed)) {
        const m = toMotion(finger, k);
        if (m.travel >= minTravel && onBoard(landing(m.end))) out.push(m);
      }
    }
    return out;
  }

  // Down-strokes that stopped inside the board since the last call: a down-then-stop of an
  // allowed finger, each reported once. Call after every frame's samples are added.
  newStops(onBoard: (p: Pt) => boolean): Motion[] {
    const { minDownSpeed, minTravel } = CONFIG.motion;
    const out: Motion[] = [];
    for (const [finger, track] of this.tracks) {
      if (!isAllowed(finger) || track.length < 2) continue;
      const from = track[track.length - 1].t - CONFIG.taps.historyMs;
      const after = this.reported.get(finger) ?? -Infinity;
      for (const k of downStrokes(track.filter((s) => s.t >= from), minDownSpeed)) {
        if (!k.stop || k.stop.t <= after) continue;
        this.reported.set(finger, k.stop.t);
        const m = toMotion(finger, k);
        if (m.travel >= minTravel && onBoard(landing(m.end))) out.push(m);
      }
    }
    return out;
  }

  // The finger that moved down fastest and then stopped around the onset. A finger
  // landing at the onset shows up in frames videoLagMs later, so the search is centered
  // there: the stop must be within stopToleranceMs of it (per finger, the stroke
  // stopping closest to it). Needs frames up to that time, so call it after they're in.
  resolve(onset: number): FingerPick | null {
    return this.resolveAll(onset)[0] ?? null;
  }

  // Every allowed finger with a stop in the window, fastest stroke first.
  resolveAll(onset: number): FingerPick[] {
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
      const at = stroke.stop!;
      picks.push({ finger, score: stroke.peak, peakSpeed: stroke.peak, at, stopOffset: at.t - expected });
    }
    return picks.sort((a, b) => b.score - a.score);
  }

  // Best guess at onset time, from the frames so far. With webcam lag the latest frames
  // often still show the finger raised, before any down-stroke, so fingers are scored by
  // vertical travel in the window (the one that lifted to strike), weighted by
  // CONFIG.guess: thumbs count less unless they travel far, and fingers already on the
  // board or on the hand that tapped last count more. The winner's landing is predicted:
  // its stop if already seen, the extrapolated stroke if it is coming down, or its
  // resting height (lowest point in the window) if still raised.
  guess(onset: number, c: GuessContext): FingerPick | null {
    return this.guessAll(onset, c)[0] ?? null;
  }

  // Every allowed finger that lifted at least minLift, scored as in guess, best first.
  guessAll(onset: number, c: GuessContext): FingerPick[] {
    const { historyMs, stopToleranceMs, videoLagMs, minLift } = CONFIG.taps;
    const g = CONFIG.guess;
    const expected = onset + videoLagMs;
    const from = expected - stopToleranceMs - historyMs;
    const picks: FingerPick[] = [];
    for (const [finger, track] of this.tracks) {
      if (!isAllowed(finger)) continue;
      const s = track.filter((p) => p.t >= from);
      if (s.length < 2) continue;
      const restY = Math.max(...s.map((p) => p.y));
      const travel = restY - Math.min(...s.map((p) => p.y));
      if (travel < minLift) continue;
      let score = travel;
      if (fingerOf(finger) === "thumb" && travel < g.thumbStrikeLift) score *= g.thumbWeight;
      if (c.onBoard(landing(s[s.length - 1]))) score *= g.onBoardWeight;
      if (c.lastHand !== null && handOf(finger) === c.lastHand) score *= g.lastHandWeight;
      const stroke = downStrokes(s).at(-1);
      let at: Sample;
      if (stroke?.stop && stroke.stop.t >= expected - stopToleranceMs) at = stroke.stop;
      else if (stroke && !stroke.stop) at = extrapolate(stroke, expected);
      else at = shifted(s[s.length - 1], s[s.length - 1].t, 0, restY - s[s.length - 1].y);
      picks.push({ finger, score, peakSpeed: stroke?.peak ?? 0, at, stopOffset: null });
    }
    return picks.sort((a, b) => b.score - a.score);
  }
}

// Downward (increasing y) strokes in order. A stroke starts when speed reaches
// minDownSpeed and stops at the last frame before speed falls below stopSpeedRatio of
// its peak. The final stroke may still be moving (stop null).
function downStrokes(s: Sample[], minDownSpeed = CONFIG.taps.minDownSpeed): Stroke[] {
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
