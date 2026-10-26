import { CONFIG } from "./config.ts";

export const FINGERTIPS = [4, 8, 12, 16, 20];
export const FINGER_NAMES = ["thumb", "index", "middle", "ring", "pinky"];

// t is when the frame's landmarks were detected, performance.now() ms. x, y are raw
// camera coords (0-1).
export type Sample = { t: number; x: number; y: number };

export type FingerPick = {
  finger: string;
  peakSpeed: number; // frame heights per second, downward
  at: Sample; // where the finger stopped, or where it should land if still moving
  stopOffset: number | null; // stop time minus expected stop time (onset + videoLagMs), ms
};

// prev is the frame before last, for extrapolating a stroke that is still moving.
type Stroke = { peak: number; stop: Sample | null; last: Sample; prev: Sample | null };

export class FingerHistory {
  private tracks = new Map<string, Sample[]>();

  add(finger: string, s: Sample) {
    let track = this.tracks.get(finger);
    if (!track) this.tracks.set(finger, (track = []));
    track.push(s);
    while (track.length && track[0].t < s.t - CONFIG.taps.keepMs) track.shift();
  }

  // The finger that moved down fastest and then stopped around the onset. A finger
  // landing at the onset shows up in frames videoLagMs later, so the search is centered
  // there: the stop must be within stopToleranceMs of it (per finger, the stroke
  // stopping closest to it). Needs frames up to that time, so call it after they're in.
  resolve(onset: number): FingerPick | null {
    const { historyMs, stopToleranceMs, videoLagMs } = CONFIG.taps;
    const expected = onset + videoLagMs;
    const from = expected - stopToleranceMs - historyMs;
    const to = expected + stopToleranceMs;
    let best: FingerPick | null = null;
    for (const [finger, track] of this.tracks) {
      const strokes = downStrokes(track.filter((s) => s.t >= from && s.t <= to));
      const stroke = nearestStop(
        strokes.filter((k) => k.stop && Math.abs(k.stop.t - expected) <= stopToleranceMs),
        expected,
      );
      if (!stroke || (best && stroke.peak <= best.peakSpeed)) continue;
      best = { finger, peakSpeed: stroke.peak, at: stroke.stop!, stopOffset: stroke.stop!.t - expected };
    }
    return best;
  }

  // Best guess at onset time, from the frames so far. With webcam lag the latest frames
  // often still show the finger raised, before any down-stroke, so this picks the finger
  // with the most vertical travel in the window (the one that lifted to strike) and
  // predicts where it lands: its stop if already seen, the extrapolated stroke if it is
  // coming down, or its resting height (lowest point in the window) if still raised.
  guess(onset: number): FingerPick | null {
    const { historyMs, stopToleranceMs, videoLagMs, minLift } = CONFIG.taps;
    const expected = onset + videoLagMs;
    const from = expected - stopToleranceMs - historyMs;
    let best: FingerPick | null = null;
    let bestTravel = minLift;
    for (const [finger, track] of this.tracks) {
      const s = track.filter((p) => p.t >= from);
      if (s.length < 2) continue;
      const restY = Math.max(...s.map((p) => p.y));
      const travel = restY - Math.min(...s.map((p) => p.y));
      if (travel < bestTravel) continue;
      bestTravel = travel;
      const stroke = downStrokes(s).at(-1);
      let at: Sample;
      if (stroke?.stop && stroke.stop.t >= expected - stopToleranceMs) at = stroke.stop;
      else if (stroke && !stroke.stop) at = extrapolate(stroke, expected);
      else at = { ...s[s.length - 1], y: restY };
      best = { finger, peakSpeed: stroke?.peak ?? 0, at, stopOffset: null };
    }
    return best;
  }
}

// Downward (increasing y) strokes in order. A stroke starts when speed reaches
// minDownSpeed and stops at the last frame before speed falls below stopSpeedRatio of
// its peak. The final stroke may still be moving (stop null).
function downStrokes(s: Sample[]): Stroke[] {
  const { minDownSpeed, stopSpeedRatio } = CONFIG.taps;
  const strokes: Stroke[] = [];
  let peak = 0;
  for (let i = 1; i < s.length; i++) {
    const v = speed(s[i - 1], s[i]);
    if (peak === 0) {
      if (v >= minDownSpeed) peak = v;
    } else if (v > peak) {
      peak = v;
    } else if (v <= peak * stopSpeedRatio) {
      strokes.push({ peak, stop: s[i - 1], last: s[i - 1], prev: null });
      peak = 0;
    }
  }
  if (peak > 0) strokes.push({ peak, stop: null, last: s[s.length - 1], prev: s[s.length - 2] });
  return strokes;
}

// Where a still-moving finger will be when its contact shows up in frames (time t),
// continuing its last frame-to-frame motion for at most maxExtrapolateMs.
function extrapolate(k: Stroke, t: number): Sample {
  const { last, prev } = k;
  if (!prev || last.t <= prev.t) return last;
  const dt = Math.min(Math.max(0, t - last.t), CONFIG.taps.maxExtrapolateMs);
  const f = dt / (last.t - prev.t);
  return { t: last.t + dt, x: last.x + (last.x - prev.x) * f, y: last.y + (last.y - prev.y) * f };
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
