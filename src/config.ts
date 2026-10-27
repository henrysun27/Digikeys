// All tunables live here. Later milestones add onset, refractory, finger history,
// videoLagMs and layout validation limits.
export const CONFIG = {
  camera: {
    mode: { width: 1280, height: 720, frameRate: 30 },
    // The debug panel's Probe button switches to this mode, lets it settle for
    // probeWarmupMs, measures its frame rate over probeMs, then goes back to mode.
    probe: { width: 640, height: 480, frameRate: 60 },
    probeWarmupMs: 1500,
    probeMs: 1000,
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
    // Where detection runs. "worker" keeps mic onsets from waiting behind it; "main" skips
    // the per-frame copy to the worker. "auto" starts in the worker and moves to the main
    // thread if the worker can't keep up with the camera and the main thread does better.
    detectOn: "worker" as "auto" | "worker" | "main",
    keepUpRatio: 0.9, // detection keeps up if its rate is at least this times the camera's
    autoWarmupMs: 1500, // auto: settle time before measuring each option...
    autoMeasureMs: 3000, // ...and how long to measure it
    powerPreference: "high-performance" as WebGLPowerPreference, // GPU asked for
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
  onset: {
    thresholdRatio: 4, // level must exceed floor * this (~12 dB)
    minLevel: 0.002, // absolute minimum threshold (~-54 dBFS)
    riseRatio: 3, // level must jump this much over the mean of the last riseLookbackMs
    riseLookbackMs: 12,
    floorFallMs: 150, // floor time constant when the level drops below it
    floorRiseMs: 2000, // ...and when it rises above it
    refractoryMs: 80,
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
    // Finger frames are detected this long after the onset of the same moment. Tune it by
    // adding the debug panel's median stop offset.
    videoLagMs: 50,
    stopToleranceMs: 150, // a stop counts within +-this of onset + videoLagMs
    historyMs: 200, // how long a down-stroke may take before it stops
    settleMarginMs: 40, // extra wait for late frames before resolving a tap
    // A stop later than this past onset + videoLagMs is likely the finger settling after
    // contact, not the contact: the check then uses the guess position instead.
    lateStopMs: 25,
    minLift: 0.015, // best guess: min vertical travel (frame heights) to count as striking
    maxExtrapolateMs: 80, // best guess: how far ahead a still-moving finger is projected
    medianTaps: 20, // taps in the debug panel's medians (stop offset, tap-to-sound)
    keepMs: 1000,
    minDownSpeed: 0.3, // frame heights/s for a downward stroke
    stopSpeedRatio: 0.3, // stopped once speed falls below this fraction of the peak
    flashMs: 300,
    logSize: 8,
    dotTaps: 30, // taps with a target whose guess/check positions are drawn on the board
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
    thumbStrikeLift: 0.04, // ...i.e. travelling at least this far (frame heights)
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
};

export type OnsetParams = typeof CONFIG.onset;
