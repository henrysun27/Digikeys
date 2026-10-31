import { CONFIG } from "./config.ts";
import type { Pt } from "./geometry.ts";
import type { HandFrame } from "./hand-detector.ts";
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

// id: a stable letter ("A", "B") that follows the physical hand from frame to frame.
// raw: the 21 landmarks as detected, for tap motion. pts: all 21 One Euro filtered, for
// display. tips: the filtered fingertips (pts at FINGERTIPS), for display and hit-testing.
// detection: its index in this frame's HandFrame, which per-detection results refer to.
export type TrackedHand = { id: string; raw: Pt[]; pts: Pt[]; tips: Pt[]; detection: number };

const INDEX = FINGERTIPS.indexOf(8);
const WRIST = 0;
const IDS = "ABCDEFGH";

type Track = {
  wrist: Pt; // raw, last frame it was seen
  seen: number; // detection time it was last seen, ms
  filters: [OneEuroFilter, OneEuroFilter][]; // x and y, per landmark
};

// Follows hands across frames by wrist position: each detection is paired with the
// nearest track (closest pairs first) whose wrist is within maxWristJump, regardless of
// MediaPipe's order or handedness label, which can swap between frames. A hand that
// vanishes keeps its ID, filters and finger history for lostGraceMs in case it comes
// back; a detection that matches nothing starts a new track with the lowest free ID.
export class HandTracking {
  private tracks = new Map<string, Track>();
  private present = new Map<string, Pt>(); // id -> filtered index tip, hands in the last frame

  // aspect: frame width / height, so wrist distances are in true proportions.
  // lost: the filtered index tip, last seen, of each hand present last frame but not now.
  // started: IDs of new tracks; finger history under them belongs to some other hand.
  update(result: HandFrame, t: number, aspect: number): { hands: TrackedHand[]; lost: Pt[]; started: string[] } {
    const { maxWristJump, lostGraceMs, numHands } = CONFIG.hands;
    for (const [id, k] of this.tracks) if (t - k.seen > lostGraceMs) this.tracks.delete(id);

    const wrists = result.landmarks.map((raw) => raw[WRIST]);
    const pairs: { d: number; h: number; id: string }[] = [];
    wrists.forEach((w, h) => {
      for (const [id, k] of this.tracks) {
        const d = Math.hypot((w.x - k.wrist.x) * aspect, w.y - k.wrist.y);
        if (d <= maxWristJump) pairs.push({ d, h, id });
      }
    });
    pairs.sort((a, b) => a.d - b.d);
    const idOf = new Map<number, string>(); // detection index -> track id
    const taken = new Set<string>();
    for (const { h, id } of pairs) {
      if (idOf.has(h) || taken.has(id)) continue;
      idOf.set(h, id);
      taken.add(id);
    }

    // New hands. Unmatched tracks only linger while there is room, so IDs stay A, B...
    const started: string[] = [];
    const fresh = wrists.map((_, h) => h).filter((h) => !idOf.has(h));
    const lingering = [...this.tracks].filter(([id]) => !taken.has(id)).sort(([, a], [, b]) => a.seen - b.seen);
    while (lingering.length && this.tracks.size + fresh.length > numHands) this.tracks.delete(lingering.shift()![0]);
    for (const h of fresh) {
      // Free, since tracks never outnumber numHands (at most IDS.length).
      const id = [...IDS].find((c) => !this.tracks.has(c))!;
      const make = () => new OneEuroFilter(CONFIG.smoothing);
      const filters = result.landmarks[h].map((): [OneEuroFilter, OneEuroFilter] => [make(), make()]);
      this.tracks.set(id, { wrist: wrists[h], seen: t, filters });
      idOf.set(h, id);
      started.push(id);
    }

    const hands: TrackedHand[] = result.landmarks.map((raw, h) => {
      const id = idOf.get(h)!;
      const k = this.tracks.get(id)!;
      const pts = raw.map((p, i) => ({ x: k.filters[i][0].filter(p.x, t), y: k.filters[i][1].filter(p.y, t) }));
      k.wrist = raw[WRIST];
      k.seen = t;
      return { id, raw, pts, tips: FINGERTIPS.map((i) => pts[i]), detection: h };
    });
    hands.sort((a, b) => a.id.localeCompare(b.id));

    // Lost: present last frame and matched by nothing now (its ID may already be reused).
    const lost = [...this.present].filter(([id]) => !taken.has(id)).map(([, tip]) => tip);
    this.present = new Map(hands.map((x) => [x.id, x.tips[INDEX]]));
    return { hands, lost, started };
  }
}
