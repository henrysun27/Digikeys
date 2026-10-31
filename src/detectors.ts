import type { HandLandmarker } from "@mediapipe/tasks-vision";
import type { DetectorInfo, HandFrame, toHandFrame } from "./hand-detector.ts";
import type { FromWorker, ToWorker } from "./hand-worker.ts";
import type { ShadowRequest, ShadowResult, sampleShadows } from "./shadow.ts";

export type DetectorKind = "worker" | "main";
// One frame's steps before the main thread handles its result, ms; null where the detector
// has no such step. copy: video frame to ImageBitmap. queue: the copy waiting for the frame
// in flight. send: posting it to the worker. detect: HandLandmarker. shadow: shadow
// sampling (its own steps are in the shadow result). back: the result's trip back.
export type FrameTiming = {
  copy: number | null;
  queue: number | null;
  send: number | null;
  detect: number;
  shadow: number | null;
  back: number | null;
};
export type OnHands = (t: number, frame: HandFrame, timing: FrameTiming, shadow: ShadowResult | null) => void;

// Epoch ms, as the worker stamps its messages (see hand-worker.ts).
const epochNow = () => performance.timeOrigin + performance.now();

// Hand detection on new video frames. frame(t, shadow) is called for every new frame, t
// being when it was grabbed (performance.now() ms); results come back through onHands,
// stamped with t, with shadow readings from the same frame if shadow asked for them.
export interface Detector {
  readonly kind: DetectorKind;
  readonly info: DetectorInfo;
  onHands: OnHands;
  frame(t: number, shadow: ShadowRequest | null): void;
  close(): void;
}

// Detection in a Web Worker: the main thread stays free for onsets, at the cost of copying
// each frame to an ImageBitmap. Pipelined: every new frame is copied right away, and the
// newest copy is posted the moment the previous result is back. Older copies waiting
// behind it are dropped, never queued.
export class WorkerDetector implements Detector {
  readonly kind = "worker";
  readonly info: DetectorInfo;
  onHands: OnHands = () => {};
  private readonly worker: Worker;
  private readonly video: HTMLVideoElement;
  private inFlight = false;
  private lastPosted = -Infinity;
  // A copy waiting for the frame in flight: copy, how long it took; copiedAt: when it was done.
  private next: { bitmap: ImageBitmap; t: number; shadow: ShadowRequest | null; copy: number; copiedAt: number } | null =
    null;
  private sent = { copy: 0, queue: 0 }; // the frame in flight's

  private closed = false;

  private constructor(info: DetectorInfo, worker: Worker, video: HTMLVideoElement) {
    this.info = info;
    this.worker = worker;
    this.video = video;
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.type !== "result") return;
      this.inFlight = false;
      const timing: FrameTiming = {
        ...this.sent,
        send: m.sendMs,
        detect: m.detectMs,
        shadow: m.shadow?.ms ?? null,
        back: Math.max(0, epochNow() - m.postedAt), // the two threads' clocks can disagree by a hair
      };
      this.onHands(m.t, m.frame, timing, m.shadow);
      const n = this.next;
      this.next = null;
      if (n && !this.closed) this.post(n.bitmap, n.t, n.shadow, n.copy, n.copiedAt);
    };
  }

  static create(video: HTMLVideoElement): Promise<WorkerDetector> {
    const worker = new Worker(new URL("./hand-worker.ts", import.meta.url), { type: "module" });
    return new Promise((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data;
        if (m.type === "ready") {
          const { type: _, ...info } = m;
          resolve(new WorkerDetector(info, worker, video));
        } else if (m.type === "error") reject(new Error(`hand worker: ${m.message}`));
      };
      worker.onerror = (e) => reject(new Error(`hand worker: ${e.message}`));
    });
  }

  frame(t: number, shadow: ShadowRequest | null) {
    const asked = performance.now();
    createImageBitmap(this.video).then(
      (bitmap) => {
        const copiedAt = performance.now();
        const copy = copiedAt - asked;
        // Copies normally resolve in order; anything older than what's queued is stale.
        if (this.closed || t <= this.lastPosted || (this.next && t <= this.next.t)) {
          bitmap.close();
          return;
        }
        if (!this.inFlight) this.post(bitmap, t, shadow, copy, copiedAt);
        else {
          this.next?.bitmap.close();
          this.next = { bitmap, t, shadow, copy, copiedAt };
        }
      },
      (err) => console.error(err),
    );
  }

  private post(bitmap: ImageBitmap, t: number, shadow: ShadowRequest | null, copy: number, copiedAt: number) {
    this.inFlight = true;
    this.lastPosted = t;
    this.sent = { copy, queue: performance.now() - copiedAt };
    this.worker.postMessage({ type: "frame", bitmap, t, shadow, sentAt: epochNow() } satisfies ToWorker, [bitmap]);
  }

  close() {
    this.closed = true;
    this.next?.bitmap.close();
    this.next = null;
    this.worker.terminate();
  }
}

// Detection on the main thread, straight from the video element (no copy), as in
// milestone 1. Faster on some GPUs, but onsets that arrive during a detection wait for it.
export class MainDetector implements Detector {
  readonly kind = "main";
  readonly info: DetectorInfo;
  onHands: OnHands = () => {};
  private readonly landmarker: HandLandmarker;
  private readonly video: HTMLVideoElement;
  private readonly toHandFrame: typeof toHandFrame;
  private readonly sampleShadows: typeof sampleShadows;
  private lastT = -Infinity;

  private constructor(
    info: DetectorInfo,
    landmarker: HandLandmarker,
    video: HTMLVideoElement,
    convert: typeof toHandFrame,
    sample: typeof sampleShadows,
  ) {
    this.info = info;
    this.landmarker = landmarker;
    this.video = video;
    this.toHandFrame = convert;
    this.sampleShadows = sample;
  }

  // MediaPipe is loaded only when the main-thread detector is used.
  static async create(video: HTMLVideoElement): Promise<MainDetector> {
    const [{ createHandLandmarker, toHandFrame }, { sampleShadows }] = await Promise.all([
      import("./hand-detector.ts"),
      import("./shadow.ts"),
    ]);
    const { landmarker, info } = await createHandLandmarker();
    return new MainDetector(info, landmarker, video, toHandFrame, sampleShadows);
  }

  frame(t: number, shadow: ShadowRequest | null) {
    const ts = Math.max(t, this.lastT + 0.001);
    this.lastT = ts;
    const start = performance.now();
    const frame = this.toHandFrame(this.landmarker.detectForVideo(this.video, ts));
    const detectMs = performance.now() - start;
    const { videoWidth: w, videoHeight: h } = this.video;
    const s = shadow ? this.sampleShadows(this.video, w, h, frame, shadow, t) : null;
    const timing = { copy: null, queue: null, send: null, detect: detectMs, shadow: s?.ms ?? null, back: null };
    this.onHands(t, frame, timing, s);
  }

  close() {
    this.landmarker.close();
  }
}

export const createDetector = (kind: DetectorKind, video: HTMLVideoElement): Promise<Detector> =>
  kind === "worker" ? WorkerDetector.create(video) : MainDetector.create(video);
