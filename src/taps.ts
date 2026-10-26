import { CONFIG } from "./config.ts";

export const FINGERTIPS = [4, 8, 12, 16, 20];
export const FINGER_NAMES = ["thumb", "index", "middle", "ring", "pinky"];

// t is when the frame was captured (detection time minus videoLagMs), in performance.now() ms.
// x, y are raw camera coords (0-1).
export type Sample = { t: number; x: number; y: number };

export type FingerPick = {
  finger: string;
  peakSpeed: number; // frame heights per second, downward
  at: Sample; // where the finger stopped, or its latest sample if it hasn't yet
  stopOffset: number | null; // stop time minus onset time, ms
};

export class FingerHistory {
  private tracks = new Map<string, Sample[]>();

  add(finger: string, s: Sample) {
    let track = this.tracks.get(finger);
    if (!track) this.tracks.set(finger, (track = []));
    track.push(s);
    while (track.length && track[0].t < s.t - CONFIG.taps.keepMs) track.shift();
  }

  // The finger that moved down fastest around the onset. With requireStop it must also
  // have stopped within the window; otherwise this is a best guess from the frames so far.
  pick(onset: number, requireStop: boolean): FingerPick | null {
    const { historyMs, stopAfterMs } = CONFIG.taps;
    const from = onset - historyMs;
    const to = requireStop ? onset + stopAfterMs : Infinity;
    let best: FingerPick | null = null;
    for (const [finger, track] of this.tracks) {
      const stroke = downStroke(track.filter((s) => s.t >= from && s.t <= to));
      if (!stroke || (requireStop && !stroke.stop)) continue;
      if (best && stroke.peak <= best.peakSpeed) continue;
      best = {
        finger,
        peakSpeed: stroke.peak,
        at: stroke.stop ?? stroke.last,
        stopOffset: stroke.stop ? stroke.stop.t - onset : null,
      };
    }
    return best;
  }
}

// Fastest downward (increasing y) movement in the samples, and the sample where the
// finger then stopped: the first frame after the peak whose speed fell below
// stopSpeedRatio of the peak.
function downStroke(s: Sample[]): { peak: number; stop: Sample | null; last: Sample } | null {
  const { minDownSpeed, stopSpeedRatio } = CONFIG.taps;
  const speeds = s.map((cur, i) => (i === 0 ? 0 : speed(s[i - 1], cur)));
  let peakIdx = -1;
  speeds.forEach((v, i) => {
    if (v >= minDownSpeed && (peakIdx < 0 || v > speeds[peakIdx])) peakIdx = i;
  });
  if (peakIdx < 0) return null;
  let stop: Sample | null = null;
  for (let i = peakIdx + 1; i < s.length; i++) {
    if (speeds[i] <= speeds[peakIdx] * stopSpeedRatio) {
      stop = s[i - 1];
      break;
    }
  }
  return { peak: speeds[peakIdx], stop, last: s[s.length - 1] };
}

function speed(a: Sample, b: Sample): number {
  const dt = b.t - a.t;
  return dt > 0 ? ((b.y - a.y) / dt) * 1000 : 0;
}
