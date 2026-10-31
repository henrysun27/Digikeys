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
// startT: when the stroke started (its first frame's time).
export type FingerPick = {
  finger: string;
  startT: number;
  depth: number;
  speed: number;
  at: Sample;
  stopped: boolean;
  why: string | null;
  score: number;
  stopOffset: number | null; // stop time minus expected stop time (onset + videoLagMs), ms
};

// Where a finger's stop may fall around onset + videoLagMs, ms (lo before, hi after).
export type StopWindow = { lo: number; hi: number };

// CONFIG.taps.stopWindowMs, stretched when the camera's measured frame interval (frameMs,
// null if not measured yet) is longer than at camera.mode.frameRate: with fewer frames, a
// stop is seen up to a frame later and strokes are cut into coarser steps.
export function stopWindow(frameMs: number | null): StopWindow {
  const [lo, hi] = CONFIG.taps.stopWindowMs;
  const nominal = 1000 / CONFIG.camera.mode.frameRate;
  const k = frameMs === null ? 1 : Math.max(1, frameMs / nominal);
  return { lo: lo * k, hi: hi * k };
}

// What the guess knows besides finger motion: board mapping, whether a camera point is on
// the board, the hand of the last tap if it was recent, and the stop window.
export type GuessContext = {
  toBoard: ToBoard;
  onBoard: (p: Pt) => boolean;
  lastHand: string | null;
  window: StopWindow;
};

// start: the frame the stroke started from. prev is the frame before last, for
// extrapolating a stroke that is still moving. held: frames after the stop frame the finger
// stayed still (speed either way at most stopSpeedRatio of the peak); holdEnded: a frame
// after those moved, so held won't grow.
type Stroke = {
  peak: number;
  start: Sample;
  stop: Sample | null;
  last: Sample;
  prev: Sample | null;
  held: number;
  holdEnded: boolean;
};

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
  return { finger, startT: start.t, depth, speed, at, stopped, why, score: 0, stopOffset: null };
}

// Strikes first, best score first; then the rest.
export const ranked = (picks: FingerPick[]) =>
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

  // Strikes that stopped inside the board since the last call and stayed still for
  // holdFrames frames after the stop frame, each stroke reported once (a stroke whose hold
  // is cut short is dropped). Call after every frame's samples are added.
  newStops(toBoard: ToBoard, onBoard: (p: Pt) => boolean, holdFrames: number): FingerPick[] {
    const out: FingerPick[] = [];
    for (const [finger, track] of this.tracks) {
      if (!isAllowed(finger) || track.length < holdFrames + 2) continue;
      // The window reaches historyMs before the latest possible stop frame, so waiting for
      // the hold doesn't cut off the start of the stroke.
      const from = track[track.length - 1 - holdFrames].t - CONFIG.taps.historyMs;
      const after = this.reported.get(finger) ?? -Infinity;
      for (const k of downStrokes(track.filter((s) => s.t >= from))) {
        if (!k.stop || k.stop.t <= after) continue;
        if (k.held < holdFrames && !k.holdEnded) continue; // still holding: decide later
        this.reported.set(finger, k.stop.t);
        if (k.held < holdFrames) continue;
        const m = judge(finger, k.start, k.stop, true, toBoard);
        if (!m.why && onBoard(landing(m.at))) out.push(m);
      }
    }
    return out;
  }

  // Every allowed finger with a stop around the onset, judged as a strike and scored by
  // speed (the fastest strike first). A finger landing at the onset shows up in frames
  // videoLagMs later, so the search is around there: the stop must be inside the window
  // (per finger, the stroke stopping closest to the expected time). Needs frames up to
  // the window's end, so call it after they're in.
  resolveAll(onset: number, toBoard: ToBoard, win: StopWindow): FingerPick[] {
    const { historyMs, videoLagMs } = CONFIG.taps;
    const expected = onset + videoLagMs;
    const from = expected + win.lo - historyMs;
    const to = expected + win.hi;
    const picks: FingerPick[] = [];
    for (const [finger, track] of this.tracks) {
      if (!isAllowed(finger)) continue;
      const strokes = downStrokes(track.filter((s) => s.t >= from && s.t <= to));
      const stroke = nearestStop(
        strokes.filter((k) => k.stop && k.stop.t >= expected + win.lo && k.stop.t <= to),
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
  // seen (not before the stop window's start), or, with webcam lag usually, the stroke
  // still coming down, extrapolated to where it should land. Strikes are scored by depth
  // weighted by CONFIG.guess: thumbs count less unless they strike deep, and fingers
  // already on the board or on the hand that tapped last count more.
  guessAll(onset: number, c: GuessContext): FingerPick[] {
    const { historyMs, videoLagMs } = CONFIG.taps;
    const g = CONFIG.guess;
    const expected = onset + videoLagMs;
    const from = expected + c.window.lo - historyMs;
    const picks: FingerPick[] = [];
    for (const [finger, track] of this.tracks) {
      if (!isAllowed(finger)) continue;
      const s = track.filter((p) => p.t >= from);
      const stroke = downStrokes(s).at(-1);
      if (!stroke) continue;
      const at = stroke.stop ?? extrapolate(stroke, expected);
      const m = judge(finger, stroke.start, at, !!stroke.stop, c.toBoard);
      if (!m.why && stroke.stop && stroke.stop.t < expected + c.window.lo) {
        m.why = `stopped too early (${(stroke.stop.t - expected).toFixed(0)} < ${c.window.lo.toFixed(0)} ms)`;
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
      // From the step that ended the stroke: a finger that slowed by lifting isn't held.
      let held = 0;
      while (i + held < s.length && Math.abs(speed(s[i + held - 1], s[i + held])) <= peak * stopSpeedRatio) held++;
      const holdEnded = i + held < s.length;
      strokes.push({ peak, start, stop: s[i - 1], last: s[i - 1], prev: null, held, holdEnded });
      peak = 0;
    }
  }
  if (peak > 0) {
    strokes.push({ peak, start, stop: null, last: s[s.length - 1], prev: s[s.length - 2], held: 0, holdEnded: false });
  }
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
