import { CONFIG } from "./config.ts";

export const FINGERTIPS = [4, 8, 12, 16, 20];
export const FINGER_NAMES = ["thumb", "index", "middle", "ring", "pinky"];

// t is when the frame's landmarks were detected, performance.now() ms. x, y are raw
// camera coords (0-1).
export type Sample = { t: number; x: number; y: number };

export type FingerPick = {
  finger: string;
  peakSpeed: number; // frame heights per second, downward
  at: Sample; // where the finger stopped, or its latest sample if it hasn't yet
  stopOffset: number | null; // stop time minus expected stop time (onset + videoLagMs), ms
};

type Stroke = { peak: number; stop: Sample | null; last: Sample };

export class FingerHistory {
  private tracks = new Map<string, Sample[]>();

  add(finger: string, s: Sample) {
    let track = this.tracks.get(finger);
    if (!track) this.tracks.set(finger, (track = []));
    track.push(s);
    while (track.length && track[0].t < s.t - CONFIG.taps.keepMs) track.shift();
  }

  // The finger that moved down fastest around the onset. A finger landing at the onset
  // shows up in frames videoLagMs later, so the search is centered there.
  // With requireStop the stroke must have stopped within stopToleranceMs of that time
  // (per finger, the stroke stopping closest to it); otherwise this is a best guess from
  // the frames so far, using each finger's latest stroke.
  pick(onset: number, requireStop: boolean): FingerPick | null {
    const { historyMs, stopToleranceMs, videoLagMs } = CONFIG.taps;
    const expected = onset + videoLagMs;
    const from = expected - stopToleranceMs - historyMs;
    const to = requireStop ? expected + stopToleranceMs : Infinity;
    let best: FingerPick | null = null;
    for (const [finger, track] of this.tracks) {
      const strokes = downStrokes(track.filter((s) => s.t >= from && s.t <= to));
      const stroke = requireStop
        ? nearestStop(strokes.filter((k) => k.stop && Math.abs(k.stop.t - expected) <= stopToleranceMs), expected)
        : strokes[strokes.length - 1];
      if (!stroke || (best && stroke.peak <= best.peakSpeed)) continue;
      best = {
        finger,
        peakSpeed: stroke.peak,
        at: stroke.stop ?? stroke.last,
        stopOffset: stroke.stop ? stroke.stop.t - expected : null,
      };
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
      strokes.push({ peak, stop: s[i - 1], last: s[i - 1] });
      peak = 0;
    }
  }
  if (peak > 0) strokes.push({ peak, stop: null, last: s[s.length - 1] });
  return strokes;
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
