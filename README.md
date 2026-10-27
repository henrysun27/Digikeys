# Desk Instrument

Turn any desk into an instrument: a webcam watches your hands over the desk and fingertip
taps play sounds. Built for the Meta Global AI Developer Hackathon (Oct 26 - Nov 4, 2026),
Build for Your World track.

## Run

```
npm install
cp .env.example .env   # then put your Meta Model API key in MODEL_API_KEY
npm run dev
```

`npm run dev` starts Vite and the API server in `server/` together. The browser never sees
the API key: it calls `/api/*`, which Vite proxies to the server, and only the server talks
to the Meta Model API.

`predev` copies the MediaPipe wasm runtime and downloads the hand landmarker model into
`public/mediapipe/` (gitignored), so everything is served from our own origin.

## Built during the hackathon

All code in this repo was written during the hackathon.

- [x] Milestone 1: webcam feed with hand landmarks (MediaPipe HandLandmarker) drawn on a
      mirrored canvas.
- [x] Milestone 2: click 4 corners of the playing surface (with on-screen hints, rejecting
      crossed/collinear clicks), compute a homography, draw the 2x7 piano layout warped onto
      the desk with key labels, highlight the key under each fingertip. Calibration is saved
      in localStorage.
- [x] Milestone 3: tap detection. An AudioWorklet finds mic onsets (adaptive noise floor,
      sudden-rise check, 80 ms refractory; browser echo cancellation, noise suppression and
      auto gain are off). Each onset is fused with ~200 ms of fingertip history: the finger
      that moved down fastest and then stopped is chosen, and its key flashes. The debug
      panel shows mic level, floor, threshold, chosen finger, stop offset and a tap log.
      Onset times come from the audio clock (`getOutputTimestamp`, minus output latency
      clamped to 0-100 ms; input latency taken as 0), and the finger search is centered on
      `videoLagMs`, which absorbs any constant offset; tune it with the median stop offset
      shown in the panel. Onsets with no hand in frame are logged as ignored.
- [x] Milestone 4: sound. Tone.js runs on the same AudioContext as the onset detector,
      with lookahead 0: a sampled Salamander piano and an acoustic drum kit (samples from
      tonejs.github.io), loaded and warmed up (muted) on "Enable mic". Each onset plays
      immediately from a best-guess finger (the one that lifted to strike, with its
      landing point predicted) without waiting for the stop; the later stopped-finger
      check is logged next to it. A layout picker switches between piano and drums.
- [x] Milestone 5: SAM 3.1 surface detection.
  - Part A: a minimal Node server (`server/index.ts`) holds the key and exposes
    `POST /api/segment`. "Detect surface" sends the current camera frame and the prompt
    from the box next to it (default `sheet of paper`) to SAM 3.1 and decodes the
    returned masks.
  - Part B: the largest mask, minus small specks, is reduced to its convex hull, and the
    hull to the enclosing quadrilateral whose corners sit where its long sides meet. That
    handles perspective, rounded corners and hands covering an edge. The corners are put in
    click order for the mirrored view and shown over the mask; Accept feeds them to the
    same homography and validation as clicked corners, Retry asks SAM again, Discard keeps
    the current calibration. Clicking 4 corners still works as the fallback.
- [x] Test mode: "Test" highlights a random target zone; each tap is scored against it
      twice, for the instant guess (what played) and the stop-based check, with session
      accuracy for both in the debug panel and per-tap ✓/✗ in the log. The guess scores
      fingers by lift weighted by `CONFIG.guess`: thumbs count less unless they travel far,
      and fingers already on the board or on the hand that tapped last count more.
- [x] Finger toggle: "Index fingers only" (default) or "All fingers" sets
      `CONFIG.fingers.allowed`; only those fingers are tap candidates for the guess and
      the check. Test accuracy is kept separately per setting. The debug panel splits
      tap-to-sound into the main-thread wait for the onset message and the guess+trigger
      time.
- [x] Tap calibration: the last 30 targeted taps are drawn on the board (guess = dot,
      check = ring; green hit the target, red missed). "Calibrate taps" walks through each
      zone's center, 3 taps each, and fits a per-axis scale + offset in board coords by
      least squares, separately for guess and check positions. The fit is saved in
      localStorage, cleared when the corners change, and applied to hit-testing. Test
      scores are kept per finger setting and tap correction, so accuracy before and after
      shows side by side.
- [x] Fixes after testing: the tap correction is offset only (a per-axis scale fit came
      out degenerate, shrinking taps toward the center) and is applied only if it cuts the
      rms error by more than 25%; "Clear correction" removes it. The piano is now one row
      of 8 white keys, C4 to C5, spanning the whole board, since most spatial misses were
      confusion between the two rows of the old 2x7 layout.
- [x] "Reset stats" clears Test-mode scores and the tap dots. When the stop comes more than
      `lateStopMs` (25 ms) after onset + `videoLagMs`, it is taken as the finger settling
      after contact, and the check uses the guess position instead; such taps are left out
      of the check fit in tap calibration.
- [x] Tracking: hand detection, presence and tracking confidences lowered to 0.3. The
      camera is asked for 1280x720 at 60 fps; the debug panel shows what it delivers and
      the measured frame rate. Fingertips go through a One Euro filter (`CONFIG.smoothing`)
      for display and hit-testing, while tap detection's motion history keeps the raw
      landmarks so down-strokes aren't blunted. Tracking dropouts (a hand present one frame
      and gone the next) are counted per board column of its last index-tip position,
      with a rate per 1000 hand frames, to show whether edge keys lose tracking.
- [x] Hand detection runs in a module Web Worker (`src/hand-worker.ts`): each new video
      frame is transferred as an ImageBitmap and landmarks come back, so mic onsets no
      longer wait behind `detectForVideo` on the main thread. The camera first tries
      640x480 @ 60 fps and keeps it if it measures more than 45 fps over a second,
      otherwise it reopens at 1280x720 (`CONFIG.camera`). The debug panel shows the mode
      in use, the probe result, and the worker's detection rate and time. Calibration is
      saved per camera resolution.

## Meta models

- **SAM 3.1** (`sam-3.1`, Responses API at `https://api.meta.ai/v1/responses`, streamed,
  one-bit masks): finds the playing surface in a camera frame (milestone 5). Called only
  from `server/index.ts`; the output is parsed with Meta's `@meta-sam/parser`.
- Muse Spark arrives in milestones 6-7.

## Tap-to-sound latency

Measured per tap as audio onset (audio clock) to Tone trigger time, plus the reported
output latency (unclamped); the median over the last 20 taps is shown in the debug panel,
and the output latency is shown on its own, with a warning above 60 ms (usually Bluetooth
audio). Measured: 66 ms median tap-to-sound, of which 52 ms is output latency. Tone runs
with `latencyHint: "interactive"` and `lookAhead: 0`, and notes trigger at
`Tone.immediate()`, so the rest is the time between the onset block and the trigger.
