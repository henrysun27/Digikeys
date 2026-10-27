// All tunables live here. Later milestones add onset, refractory, finger history,
// videoLagMs and layout validation limits.
export const CONFIG = {
  camera: {
    width: 1280,
    height: 720,
    frameRate: 60,
  },
  hands: {
    wasmPath: "/mediapipe/wasm",
    modelPath: "/mediapipe/hand_landmarker.task",
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
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
  },
  // Fusing onsets with fingertip motion.
  taps: {
    // Finger frames are detected this long after the onset of the same moment. Tune it by
    // adding the debug panel's median stop offset.
    videoLagMs: 50,
    stopToleranceMs: 150, // a stop counts within +-this of onset + videoLagMs
    historyMs: 200, // how long a down-stroke may take before it stops
    settleMarginMs: 40, // extra wait for late frames before resolving a tap
    minLift: 0.015, // best guess: min vertical travel (frame heights) to count as striking
    maxExtrapolateMs: 80, // best guess: how far ahead a still-moving finger is projected
    medianTaps: 20, // taps in the debug panel's medians (stop offset, tap-to-sound)
    keepMs: 1000,
    minDownSpeed: 0.3, // frame heights/s for a downward stroke
    stopSpeedRatio: 0.3, // stopped once speed falls below this fraction of the peak
    flashMs: 300,
    logSize: 8,
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
    boundaryPrompt: "desk", // a short noun phrase naming one concept
    jpegQuality: 0.9,
  },
};

export type OnsetParams = typeof CONFIG.onset;
