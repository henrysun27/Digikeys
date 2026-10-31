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
  // One Euro filter on every hand landmark for display and hit-testing; tap detection's
  // motion history stays raw. Positions are 0-1 camera coords. minCutoff and beta can be
  // tuned live from the debug panel's sliders (ranges [min, max, step]); the tuned values
  // are saved under storageKey and override these defaults.
  smoothing: {
    minCutoff: 0.75, // Hz when still: lower is smoother but lags more
    beta: 10, // cutoff rise per (frame width/s) of speed: higher lags less when moving
    dCutoff: 1, // Hz, for the speed estimate
    sliders: { minCutoff: [0.05, 3, 0.05], beta: [0, 40, 0.5] },
    storageKey: "desk-instrument.smoothing",
    jitterWindowMs: 1000, // the jitter readout: RMS distance from the mean tip over this long
  },
  calibration: {
    storageKey: "desk-instrument.calibration",
    // Both in normalized camera coords. minCornerCross is twice the triangle area any
    // three consecutive corners must span, to reject near-collinear clicks.
    minCornerDist: 0.03,
    minCornerCross: 0.002,
  },
  // Mic onset detection (runs in the audio worklet). Levels are block RMS, 0-1.
  // In hybrid and fused mode an onset also needs a finger strike
  // (taps.minStrokeDepth/minStrikeSpeed).
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
    // Audio clock -> performance.now(): re-synced on every worklet message, the offset is
    // the median over smoothMs; the drift rate is fitted over driftWindowS, one point per
    // driftSampleMs.
    clock: { smoothMs: 1000, driftSampleMs: 1000, driftWindowS: 120 },
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
    // "fused": hybrid, with each striking finger's score adjusted by its shadow's vote
    // (CONFIG.shadow.vote). The toolbar toggle switches it.
    mode: "hybrid" as "hybrid" | "vision" | "fused",
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
  // Shadow contact (Mic + motion + shadow): a fingertip touching the desk meets its own
  // shadow, a hovering one has a gap. Each frame, a patch around each fingertip is read from a
  // downscaled grayscale grab (where detection runs), normalized against the empty desk, and
  // the shadow found in it (src/shadow.ts). Lengths are in units of the finger's MCP-PIP
  // distance in the frame, so they don't change with distance to the camera.
  shadow: {
    downscale: 0.5, // the grab's scale against the camera frame
    patchRadius: 1.5, // units each way from the tip
    patchCells: 48, // cells across
    sectorDeg: 60, // the shadow is searched this far either side of the light direction
    deskPercentile: 0.7, // of the patch's normalized cells, taken as the desk level
    minDarken: 0.12, // a shadow cell is at least this much darker than the desk level
    minArea: 4, // cells, smallest shadow region
    nearWeight: 0.5, // units: a region's darkness counts for less with distance from the tip
    handHalfWidth: 0.3, // units either side of each bone that count as the hand (fingers are wider than their bones, and landmarks jitter)
    // Mean darkening of the shadow found; below it, the shadow is too faint to judge (the
    // Shadow check warns, calibration rejects the frame, and no contact is read).
    minShadowContrast: 0.18,
    // Shadow confidence, 0-1: the shadow region's contrast mapped linearly from
    // confidence[0] (0) to confidence[1] (1); 0 with no region found.
    confidence: [0.1, 0.3] as [number, number],
    // Fused mode: on an onset, each striking finger's score is multiplied by 1 + c × cue,
    // c its median shadow confidence over the stroke's frames, cue +boost if the gap ended
    // near zero (calibrated: under the threshold) or shrank by at least minShrink over the
    // stroke, -penalty if a clear gap persisted (calibrated: threshold + hoverMargin or more;
    // uncalibrated: minHoverGap or more) without shrinking, else 0. A strike whose factor
    // falls under vetoFactor is dropped as hovering. With no shadow seen, c is 0 and the
    // factor 1: plain Mic + motion. The guess votes on frames up to the onset (no waiting);
    // the check on frames up to stopSlackMs after its stop.
    vote: { boost: 0.5, penalty: 1, vetoFactor: 0.4, minShrink: 0.05, hoverMargin: 0.1, minHoverGap: 0.6, stopSlackMs: 50 },
    // The empty desk: frames with no hand, blended in at most every intervalMs.
    background: { intervalMs: 500, blend: 0.3 },
    hysteresis: 0.03, // contact ends only above threshold + this
    // Test mode's hover judge: a played finger hovered if, from confirmWindowMs[0] to [1]
    // around onset + taps.videoLagMs, it made no contact (calibrated) or every confident
    // frame showed a gap of vote.minHoverGap or more (uncalibrated).
    confirmWindowMs: [-100, 150] as [number, number],
    keepMs: 2000, // contacts and gaps kept this long
    // "Calibrate shadow": hands off (background), then rest / lift twice, each step showing
    // its prompt for settleMs before measuring stepMs. The first round finds the light
    // direction (searching all around); the second measures within sectorDeg of it. Frames
    // with no shadow or one under minShadowContrast are rejected. Separation is d' on the
    // second round: (median lifted - median resting) / rms of their robust sigmas (1.4826
    // MAD), which must reach minShadowSeparation, with at least minSamples frames per step.
    minShadowSeparation: 2,
    calibration: { settleMs: 1000, stepMs: 2000, minSamples: 10, histogramBins: 24 },
    storageKey: "desk-instrument.shadow.v2",
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
  // Instrument specs from Muse Spark, through Chat Completions with a JSON schema (model ID
  // from https://dev.meta.ai/docs/models). It picks what to build; instrument.ts builds it.
  muse: {
    model: "muse-spark-1.3",
    defaultRequest: "drum kit", // default for the instrument box
    reasoningEffort: "minimal", // minimal | low | medium | high | xhigh ("none" is a 400)
    // Reasoning plus the JSON. A spec is ~150 tokens; freeform zones need more.
    maxCompletionTokens: 4000,
    jpegQuality: 0.85,
  },
  // Object pads (milestone 7). SAM 3.1 has no prompt-free mode (one noun phrase, or
  // box/point prompts, per request), so Muse Spark first lists the kinds of objects on the
  // desk and each name becomes a SAM 3.1 text prompt, all run in parallel.
  objects: {
    maxNames: 12, // kinds of objects Muse Spark may list
    listMaxCompletionTokens: 2000,
    // Two matches sharing more than this fraction of the smaller one are the same object
    // (listed under two names, or one is part of the other): the more confident one is kept.
    maxOverlap: 0.5,
    boardIoU: 0.6, // a match overlapping the calibrated board this much is the board itself
    overlapGrid: 320, // cells across the frame when measuring overlaps
    maxObjects: 24, // pads at most, most confident first
    maxPts: 16, // outline vertices (convex hull, simplified)
    // Outline points may be at most 1/minDepthRatio times as far (along the desk plane, in
    // perspective) as the board's center; nearer the plane's horizon the homography blows up.
    minDepthRatio: 0.25,
    // Crops for Muse Spark: the match's box plus this margin (fraction of its larger side,
    // at least cropMinMarginPx), scaled to cropMinPx-cropMaxPx on the larger side, with
    // everything outside the mask dimmed by cropDim.
    cropMargin: 0.25,
    cropMinMarginPx: 12,
    cropMinPx: 256,
    cropMaxPx: 448,
    cropDim: 0.6,
    jpegQuality: 0.85,
    maxCompletionTokens: 1500,
    // Above every instrument zone (z 0-1), so an object on the paper wins taps there.
    // Smaller objects get a higher z still, so a phone on a notebook beats the notebook.
    baseZ: 100,
  },
  // Push-to-talk instrument requests through Muse Voice Transcribe (POST /v1/asr/transcribe,
  // model ID from https://dev.meta.ai/docs/models). It takes mono 16-bit WAV at 16 or 24 kHz.
  voice: {
    model: "muse-voice-transcribe-1.0",
    sampleRate: 16000,
    maxMs: 5000, // recording stops and sends by itself after this
    minMs: 300, // shorter presses are dropped as accidental
    // Taps stay paused this long after recording ends, for the last syllable and the click
    // of the released key.
    resumeTapsMs: 400,
    maxGain: 8, // quiet speech (the mic has auto gain off) is boosted up to this...
    targetPeak: 0.9, // ...toward this peak
    // Recognition is biased toward these terms; it doesn't force them.
    keywords: ["drum kit", "piano", "xylophone", "marimba", "bongos", "glockenspiel", "kalimba", "steel drum"],
    maxWavBytes: 1_000_000, // 5 s at 16 kHz is 160 kB
  },
  // The layout engine (instrument.ts) for keyboards: black keys are blackKeyDepth of the
  // board deep from the far edge, and minZoneWidth wide, kept within blackKeyWidth (fractions
  // of a white key) so narrow white keys keep a usable neck between them.
  keyboard: {
    blackKeyDepth: 0.5,
    blackKeyWidth: [0.5, 0.7] as [number, number],
  },
  // Checks on generated layouts, in board coords (0-1 on both axes). A layout that fails
  // any of them is replaced by the matching preset.
  layoutLimits: {
    maxZones: 49, // a 4-octave piano, C to C
    maxPolyPts: 16,
    minZoneSide: 0.05, // each zone's depth (y)
    // About one finger across the player's view (left to right). Narrower zones are still
    // built when the request asks for them (explicit requests win), with a warning.
    minZoneWidth: 0.07,
    minZoneArea: 0.004,
    boundsTolerance: 0.005, // coords this far outside 0-1 are clamped, not rejected
    maxOverlap: 0.02, // fraction of the smaller zone two zones may share (rounding slop)
    checkGrid: 200, // samples per axis when measuring zone areas and overlaps
    anchorGrid: 60, // samples per axis when finding where to label and aim at a zone
    noteOctaves: [1, 7], // allowed octaves for note zones
    aspectRange: [0.2, 5], // plausible board width / depth; checked for freeform layouts
  },
};

export type OnsetParams = typeof CONFIG.onset;
