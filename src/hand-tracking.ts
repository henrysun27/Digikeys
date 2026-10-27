import { CONFIG } from "./config.ts";
import type { Pt } from "./geometry.ts";
import type { HandFrame } from "./hand-worker.ts";
import { OneEuroFilter } from "./one-euro.ts";
import { FINGERTIPS } from "./taps.ts";

// MediaPipe's 21-landmark hand skeleton: wrist 0, then 4 joints per finger, thumb first.
export const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17],
];

// side: MediaPipe's handedness label, made unique within the frame ("Right 2" if both hands
// read as Right). raw: the 21 landmarks as detected. tips: One Euro filtered fingertips,
// in FINGERTIPS order, for display and hit-testing.
export type TrackedHand = { side: string; raw: Pt[]; tips: Pt[] };

const INDEX = FINGERTIPS.indexOf(8);

// Filters fingertips per hand and notices hands that drop out. A hand that disappears
// starts with fresh filters when it comes back.
export class HandTracking {
  private filters = new Map<string, [OneEuroFilter, OneEuroFilter][]>();
  private lastIndexTip = new Map<string, Pt>(); // side -> filtered index tip last frame

  // lost: the filtered index tip, last seen, of each hand present last frame but not now.
  update(result: HandFrame, t: number): { hands: TrackedHand[]; lost: Pt[] } {
    const hands: TrackedHand[] = [];
    result.landmarks.forEach((raw, h) => {
      const label = result.handedness[h]?.[0]?.categoryName ?? "Hand";
      let side = label;
      for (let n = 2; hands.some((x) => x.side === side); n++) side = `${label} ${n}`;
      let f = this.filters.get(side);
      if (!f) {
        const make = () => new OneEuroFilter(CONFIG.smoothing);
        this.filters.set(side, (f = FINGERTIPS.map(() => [make(), make()])));
      }
      const tips = FINGERTIPS.map((i, k) => ({ x: f[k][0].filter(raw[i].x, t), y: f[k][1].filter(raw[i].y, t) }));
      hands.push({ side, raw, tips });
    });

    const lost: Pt[] = [];
    for (const [side, at] of this.lastIndexTip) {
      if (hands.some((x) => x.side === side)) continue;
      lost.push(at);
      this.lastIndexTip.delete(side);
      this.filters.delete(side);
    }
    for (const hand of hands) this.lastIndexTip.set(hand.side, hand.tips[INDEX]);
    return { hands, lost };
  }
}
