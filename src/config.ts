// All tunables live here. Later milestones add onset, refractory, finger history,
// videoLagMs and layout validation limits.
import type { Edge } from "./orientation.ts";

export const CONFIG = {
  camera: {
    mode: { width: 1280, height: 720, frameRate: 30 },
    // The debug panel's Probe button switches to this mode, lets it settle for
    // probeWarmupMs, measures its frame rate over probeMs, then goes back to mode.
    probe: { width: 640, height: 480, frameRate: 60 },
    probeWarmupMs: 1500,
    probeMs: 1000,
    lowFpsWarn: 25, // warn in the debug panel when the measured frame rate drops below this
  },
  hands: {
    wasmPath: "/mediapipe/wasm",
    modelPath: "/mediapipe/hand_landmarker.task",
    numHands: 2,
    // Low, to keep hard-to-see hands (e.g. at the board's edges) tracked.
    minHandDetectionConfidence: 0.3,
    minHandPresenceConfidence: 0.3,
    minTrackingConfidence: 0.3,
    dropoutColumns: 8, // board columns that tracking dropouts are counted in
    // Hands are matched frame to frame by wrist position (nearest first), not by
    // MediaPipe's index or handedness label, which can swap between frames.
    maxWristJump: 0.25, // frame heights a wrist may move between matched detections
    lostGraceMs: 200, // a vanished hand keeps its ID and history this long, to rematch
    // Where detection runs. "worker" keeps mic onsets from waiting behind it; "main" skips
    // the per-frame copy to the worker. "auto" starts in the worker and moves to the main
    // thread if the worker can't keep up with the camera and the main thread does better.
    detectOn: "worker" as "auto" | "worker" | "main",
    keepUpRatio: 0.9, // detection keeps up if its rate is at least this times the camera's
    autoWarmupMs: 1500, // auto: settle time before measuring each option...
    autoMeasureMs: 3000, // ...and how long to measure it
    powerPreference: "high-performance" as WebGLPowerPreference, // GPU asked for
  },
  // Where the player sits: a board edge ("1-2" runs from corner 1 to corner 2), detected
  // from hand pose and stored here; null until detected, when the edge nearest the top of
  // the camera image is assumed. Layouts are written near/far and left/right from the
  // player (low notes on their left, piano sharps on the far edge) and placed by it.
  playerEdge: null as Edge | null,
  player: {
    windowMs: 3000, // hand frames averaged
    minSamples: 30, // hand frames needed in the window before deciding
    minAgreement: 0.5, // length of the mean of the unit wrist directions, 0-1
    minReach: 0.05, // board units: shorter fingertips-to-wrist spans are skipped
    boardMargin: 0.15, // fingertips this far outside the board (board units) still count
  },
  // One Euro filter on fingertip positions for display and hit-testing; tap detection's
  // motion history stays raw. Positions are 0-1 camera coords.
  smoothing: {
    minCutoff: 1.5, // Hz when still: lower is smoother but lags more
    beta: 10, // cutoff rise per (frame width/s) of speed: higher lags less when moving
    dCutoff: 1, // Hz, for the speed estimate
  },
  calibration: {
    storageKey: "desk-instrument.calibration",
    // Both in normalized camera coords. minCornerCross is twice the triangle area any
    // three consecutive corners must span, to reject near-collinear clicks.
    minCornerDist: 0.03,
    minCornerCross: 0.002,
  },
  // Mic onset detection (runs in the audio worklet). Levels are block RMS, 0-1.
  // In hybrid mode an onset also needs a finger strike (taps.minStrokeDepth/minStrikeSpeed).
  onset: {
    floorWindowMs: 1000, // the floor is the running median level over this long
    thresholdDb: 8, // level must exceed the floor by this
    minLevelDb: -66, // absolute minimum threshold, dBFS
    // Transient check: the level must also be at least minRiseDb over the RMS of the
    // riseBaselineMs before the last riseWithinMs, i.e. have jumped within riseWithinMs.
    // Background noise that wanders, however loud, doesn't jump like a tap.
    minRiseDb: 8,
    riseBaselineMs: 50,
    riseWithinMs: 10,
    // Not a refractory (that is per zone, taps.zoneRefractoryMs): one tap's transient can
    // pass the rise check in several consecutive blocks, and this merges them into one
    // onset. Short, so a second finger landing just after the first still gets its own.
    mergeMs: 25,
    reportMs: 30, // how often the worklet posts levels for the debug panel
  },
  mic: {
    maxLatencyCorrectionMs: 100, // any latency correction is clamped to 0..this
  },
  sound: {
    pianoBaseUrl: "https://tonejs.github.io/audio/salamander/",
    drumBaseUrl: "https://tonejs.github.io/audio/drum-samples/acoustic-kit/",
    noteSeconds: 1.5,
    velocity: 0.8,
    warmupMs: 200, // muted warm-up after loading
    outputLatencyWarnMs: 60, // warn above this reported output latency (likely Bluetooth)
  },
  // Fusing onsets with fingertip motion.
  taps: {
    // "hybrid": mic onsets, kept only if an allowed finger strikes (below). "vision": a down-stroke that stops on the board is the tap, no mic.
    // The toolbar toggle switches it.
    mode: "hybrid" as "hybrid" | "vision",
    // Finger frames are detected this long after the onset of the same moment. Tune it by
    // adding the debug panel's median stop offset.
    videoLagMs: 50,
    // A stop counts from stopWindowMs[0] to [1] around onset + videoLagMs. Set for
    // camera.mode.frameRate; stretched by (measured frame interval / nominal) when the
    // camera delivers fewer frames, never shrunk.
    stopWindowMs: [-300, 150] as [number, number],
    historyMs: 200, // how long a down-stroke may take before it stops
    settleMarginMs: 40, // extra wait for late frames before resolving a tap
    // A stop later than this past onset + videoLagMs is likely the finger settling after
    // contact, not the contact: the check then uses the guess position instead.
    lateStopMs: 25,
    maxExtrapolateMs: 80, // best guess: how far ahead a still-moving finger is projected
    medianTaps: 20, // taps in the debug panel's medians (stop offset, tap-to-sound)
    keepMs: 1000,
    stopSpeedRatio: 0.3, // stopped once speed falls below this fraction of the peak
    // Vision-only: the stop must hold (frame-to-frame speed, up or down, still under
    // stopSpeedRatio of the peak) for this many frames after the stop frame, so a finger
    // bouncing straight back up isn't a tap.
    visionHoldFrames: 2,
    // A finger strikes only if it went down at least minStrokeDepth (board units, start to
    // end of the stroke) at a mean speed of at least minStrikeSpeed (board units/s), then
    // stopped. Applies to every played note, the check, vision taps and the miss log; the
    // tap log shows the measured values of fingers that fall short.
    minStrokeDepth: 0.02, // real presses measured ~0.025
    minStrikeSpeed: 0.25,
    // Chords: an accepted onset plays every striking finger landing on the board whose
    // score is at least this fraction of the best such finger's (one note per zone). Lower
    // catches more of a chord, and more sympathetic finger motion; each note must still
    // pass the strike test on its own. Real chord fingers measured 0.45-0.53.
    chordRatio: 0.4,
    zoneRefractoryMs: 80, // a zone can't play again sooner than this; other zones can
    flashMs: 300,
    logSize: 8,
    dotTaps: 30, // taps with a target whose guess/check positions are drawn on the board
  },
  motion: {
    // Where down-strokes start and end (camera frame heights/s). Low on purpose: whether a
    // stroke is a strike is judged in board units by taps.minStrokeDepth/minStrikeSpeed.
    minDownSpeed: 0.1,
    missWindowMs: 150, // test mode: a stop with no accepted onset within this is a miss
    keepMs: 2000, // how long onset times and mic levels are kept for miss checks
  },
  // Test mode targets.
  test: {
    chordChance: 0.3, // share of targets that are a two-zone chord
    chordWindowMs: 120, // taps this soon after a chord attempt's first one count toward it
  },
  // "Calibrate taps": an offset in board coords, fitted separately for guess and check
  // positions.
  tapCalibration: {
    storageKey: "desk-instrument.tap-correction",
    tapsPerZone: 3,
    minPairs: 6, // fewer usable taps than this leaves that correction off
    minImprovement: 0.25, // apply only if the offset cuts rms error by more than this
  },
  // Which fingers (FINGER_NAMES) are tap candidates, for both the guess and the check.
  // The toolbar toggle switches this between ["index"] and all fingers.
  fingers: {
    allowed: ["index"] as string[],
  },
  // Best-guess finger scoring: vertical travel times these weights.
  guess: {
    thumbWeight: 0.4, // thumbs, unless clearly striking...
    thumbStrikeDepth: 0.06, // ...i.e. striking at least this deep (board units)
    onBoardWeight: 1.5, // fingers whose latest frame is inside the board
    lastHandWeight: 1.3, // fingers on the hand of the last tap...
    lastHandMs: 1500, // ...if it was at most this long ago
  },
  // The Node server in server/ (holds the API key; the browser only talks to it via /api).
  server: {
    port: 8787,
    apiBaseUrl: "https://api.meta.ai/v1",
    maxBodyBytes: 8_000_000, // one JPEG frame as a data URL
    maxPromptChars: 100,
  },
  // Surface detection with SAM 3.1 (model ID from https://dev.meta.ai/docs/models).
  sam: {
    model: "sam-3.1",
    boundaryPrompt: "sheet of paper", // default for the prompt box; a short noun phrase
    jpegQuality: 0.9,
    minBlobFrac: 0.02, // mask pieces smaller than this fraction of the mask are specks
    minSurfaceFrac: 0.05, // reject a surface mask smaller than this fraction of the frame
    looseFitRatio: 1.3, // warn when the fitted quad's area exceeds the mask's by this ratio
  },
  // Instrument layouts from Muse Spark, through Chat Completions with a JSON schema
  // (model ID from https://dev.meta.ai/docs/models).
  muse: {
    model: "muse-spark-1.3",
    defaultRequest: "drum kit", // default for the instrument box
    reasoningEffort: "low", // minimal | low | medium | high | xhigh ("none" is a 400)
    maxCompletionTokens: 8000, // reasoning plus the JSON
    jpegQuality: 0.85,
  },
  // Checks on generated layouts, in board coords (0-1 on both axes). A layout that fails
  // any of them is replaced by the matching preset.
  layoutLimits: {
    maxZones: 24,
    maxPolyPts: 16,
    minZoneSide: 0.05, // each zone's bounding box, along both axes
    // ...and at least this wide across the player's view (left to right), about one finger.
    // Caps how many zones fit side by side: a piano gets about one octave.
    minZoneWidth: 0.07,
    minZoneArea: 0.004,
    boundsTolerance: 0.005, // coords this far outside 0-1 are clamped, not rejected
    maxOverlap: 0.02, // fraction of the smaller zone two zones may share (rounding slop)
    checkGrid: 200, // samples per axis when measuring zone areas and overlaps
    noteOctaves: [1, 7], // allowed octaves for note zones
    aspectRange: [0.2, 5], // plausible board width / depth
  },
};

export type OnsetParams = typeof CONFIG.onset;
