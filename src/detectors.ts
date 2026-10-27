import type { HandLandmarker } from "@mediapipe/tasks-vision";
import type { DetectorInfo, HandFrame, toHandFrame } from "./hand-detector.ts";
import type { FromWorker, ToWorker } from "./hand-worker.ts";

export type DetectorKind = "worker" | "main";
export type OnHands = (t: number, frame: HandFrame, detectMs: number) => void;

// Hand detection on new video frames. frame(t) is called for every new frame, t being when
// it was grabbed (performance.now() ms); results come back through onHands, stamped with t.
export interface Detector {
  readonly kind: DetectorKind;
  readonly info: DetectorInfo;
  onHands: OnHands;
  frame(t: number): void;
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
  private next: { bitmap: ImageBitmap; t: number } | null = null;
  private closed = false;

  private constructor(info: DetectorInfo, worker: Worker, video: HTMLVideoElement) {
    this.info = info;
    this.worker = worker;
    this.video = video;
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.type !== "result") return;
      this.inFlight = false;
      this.onHands(m.t, m.frame, m.detectMs);
      const n = this.next;
      this.next = null;
      if (n && !this.closed) this.post(n.bitmap, n.t);
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

  frame(t: number) {
    createImageBitmap(this.video).then(
      (bitmap) => {
        // Copies normally resolve in order; anything older than what's queued is stale.
        if (this.closed || t <= this.lastPosted || (this.next && t <= this.next.t)) {
          bitmap.close();
          return;
        }
        if (!this.inFlight) this.post(bitmap, t);
        else {
          this.next?.bitmap.close();
          this.next = { bitmap, t };
        }
      },
      (err) => console.error(err),
    );
  }

  private post(bitmap: ImageBitmap, t: number) {
    this.inFlight = true;
    this.lastPosted = t;
    this.worker.postMessage({ type: "frame", bitmap, t } satisfies ToWorker, [bitmap]);
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
  private lastT = -Infinity;

  private constructor(info: DetectorInfo, landmarker: HandLandmarker, video: HTMLVideoElement, convert: typeof toHandFrame) {
    this.info = info;
    this.landmarker = landmarker;
    this.video = video;
    this.toHandFrame = convert;
  }

  // MediaPipe is loaded only when the main-thread detector is used.
  static async create(video: HTMLVideoElement): Promise<MainDetector> {
    const { createHandLandmarker, toHandFrame } = await import("./hand-detector.ts");
    const { landmarker, info } = await createHandLandmarker();
    return new MainDetector(info, landmarker, video, toHandFrame);
  }

  frame(t: number) {
    const ts = Math.max(t, this.lastT + 0.001);
    this.lastT = ts;
    const start = performance.now();
    const r = this.landmarker.detectForVideo(this.video, ts);
    this.onHands(t, this.toHandFrame(r), performance.now() - start);
  }

  close() {
    this.landmarker.close();
  }
}

export const createDetector = (kind: DetectorKind, video: HTMLVideoElement): Promise<Detector> =>
  kind === "worker" ? WorkerDetector.create(video) : MainDetector.create(video);
