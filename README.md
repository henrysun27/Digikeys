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
      longer wait behind `detectForVideo` on the main thread. The worker uses the GPU
      delegate (falling back to CPU only if GPU fails), and the debug panel shows the
      delegate, the worker's WebGL renderer, and the detection rate and time. The camera
      opens at 1280x720 @ 30 (`CONFIG.camera.mode`). A startup probe of 640x480 @ 60 was
      dropped after it picked a slower mode; the debug panel's Probe button still measures
      that mode on demand and then returns to the default. Calibration is saved per
      camera resolution.
- [x] Detection placement: frames to the worker are pipelined (every new frame is copied
      as it arrives and the newest copy is sent the moment the previous result is back;
      older copies are dropped). MediaPipe gets a WebGL2 context created with
      `powerPreference: "high-performance"`. `CONFIG.hands.detectOn` picks the worker
      (default), the main thread, or "auto": start in the worker and, if it detects fewer
      than 90% of camera frames, measure the main thread and keep whichever is faster.
      `?detect=worker`, `?detect=main` or `?detect=auto` overrides it for comparing. The
      debug panel shows where detection runs, the GPU renderer, and the auto measurements.
- [x] Milestone 6 (text input; voice comes next): type an instrument ("drum kit", "8-key
      piano in C major", "marimba") and press Generate. The server (`POST /api/layout`) sends
      Muse Spark the request, the current frame (mirrored as on screen, with the accepted
      board outlined and its corners numbered) and the corner pixel positions. Muse Spark
      estimates the board's real width/depth from the frame and returns a Layout sized for
      it, as JSON constrained by a schema (`server/layout-prompt.ts`). The browser checks it
      (`checkLayout` in `src/layout.ts`, limits in `CONFIG.layoutLimits`): zones inside 0-1,
      at least the minimum size, no overlaps (measured on a sample grid, so rects and
      polygons are treated alike), known notes and drum samples, a plausible aspect. A
      layout that fails, or a failed request, falls back to the matching preset (drums for
      percussive requests, otherwise piano) with the reason in the layout status line. The
      generated layout joins the instrument picker. Generation takes about 5-15 s.
      The shape schema is one flat object with `kind` plus all fields rather than an
      `anyOf` of rect and poly: the API writes keys in alphabetical order, so with `anyOf`
      the first key picked the branch and a model starting with `kind` was forced into a
      polygon with made-up points (2 of 4 piano requests came back that way).
- [x] Two-hand tracking: hands are followed frame to frame by wrist position instead of
      MediaPipe's hand index or handedness label, which could swap between frames and mix
      the two hands' finger histories. Each detection pairs with the nearest tracked wrist
      (closest pairs first) within `maxWristJump` (0.25 frame heights); a hand that vanishes
      keeps its ID, smoothing filters and finger history for `lostGraceMs` (200 ms) so a
      brief dropout reattaches, and a hand that matches nothing gets the lowest free ID
      with its history cleared. Finger histories are keyed by that ID, and each hand shows
      its ID (A or B) in a badge below the wrist.
- [x] Light-touch taps, with two tap modes (toolbar toggle, `CONFIG.taps.mode`):
  - Mic + motion (hybrid, default): the onset threshold is the noise floor + 5 dB (rise
    check also 5 dB, absolute minimum -66 dBFS; `CONFIG.onset`), low enough for light
    fingertip contact. An onset is kept only if an allowed finger has a down-stroke in the
    finger search window that ends (stopped or still moving) inside the board; otherwise
    it is logged as "rejected (no finger motion)" with its level. Down-strokes here use
    `CONFIG.motion`: at least 0.1 frame heights/s and 1% of the frame height of travel.
  - Vision only: a down-stroke of an allowed finger that stops inside the board plays at
    the stop position, with no mic (the button then only loads sounds). The debug panel
    shows its latency from the stop frame's timestamp to the trigger plus output latency,
    and the estimated latency from contact (adding `videoLagMs`). Test scores are kept
    per mode.
  - Missed taps: in Test mode (hybrid), a down-then-stop inside the board with no
    accepted onset within 150 ms of when its onset would have been is logged as
    "missed (no onset)" with the peak mic level and threshold around then, and whether
    an onset there was rejected by the motion gate.
  - In simulation, random landmark noise of σ 0.003 frame heights on a resting finger gives
    about 6 false stops per 10 s (none at σ 0.002). That affects vision-only taps and the
    miss log, not hybrid taps, which also need an onset.
- [x] Chords: each accepted onset plays every allowed finger whose strike score is at
      least `CONFIG.taps.chordRatio` (0.6) of the best finger's, one note per zone. The
      refractory is per zone (`zoneRefractoryMs`, 80 ms): a zone can't retrigger, but
      another finger's zone can, so a second finger landing just after the first plays on
      its own onset. The ratio is always taken against the best finger, so a second onset
      from one tap can't promote a weaker finger. The worklet keeps only a 25 ms merge
      window (`onset.mergeMs`) so one tap's transient isn't counted as several onsets.
      In vision-only mode each finger's stop is its own tap, so chords need nothing extra.
      The check resolves every stopped finger the same way and the tap log shows both
      chords.
- [x] Chord targets in Test mode: 30% of targets (`CONFIG.test.chordChance`) are two
      zones, highlighted together. Taps within 120 ms of the first (`chordWindowMs`) count
      toward the same attempt, and it is a hit only if both zones played (guess) or were
      found by the stop check. Chord scores are listed separately, and zones that played
      without being targeted are counted as extra notes.
- [x] Stricter strikes, against false presses from slight finger movement: a finger
      strikes only if its down-stroke went at least `CONFIG.taps.minStrokeDepth` (0.03)
      down the board, measured in board units through the homography, at a mean speed of
      at least `minStrikeSpeed` (0.25 board units/s), and stopped. Every played note must
      pass this on its own before the chord ratio (now 0.8) applies; the stop check,
      vision-only taps and the miss log use the same test. For the instant guess the stop
      usually isn't in the frames yet, so a stroke still coming down is measured to its
      extrapolated landing (up to `maxExtrapolateMs`) and marked "predicted" in the log.
      The onset threshold is now the floor + 8 dB, with the 5 dB sudden-rise check kept.
      The tap log lists every moving finger that didn't play and why, with the measured
      value: "too shallow (0.021 < 0.03)", "too slow (0.18/s < 0.25/s)", "below ratio
      (0.71 < 0.8)", "stopped too early", or "in refractory"; the check lists the same.
      An onset with no striking finger is logged as "rejected (no strike: ...)".
      In simulation a slight wiggle (0.8% of the frame height, 0.02 board) fails the check
      as too shallow, but the instant guess, extrapolating, can measure it at 0.03 and
      play it; lowering `maxExtrapolateMs` trades that against cutting short real taps
      whose last frames haven't arrived.

## Meta models

- **SAM 3.1** (`sam-3.1`, Responses API at `https://api.meta.ai/v1/responses`, streamed,
  one-bit masks): finds the playing surface in a camera frame (milestone 5). Called only
  from `server/index.ts`; the output is parsed with Meta's `@meta-sam/parser`.
- **Muse Spark 1.3** (`muse-spark-1.3`, Chat Completions at
  `https://api.meta.ai/v1/chat/completions`, image input, `response_format` JSON schema,
  `reasoning_effort: "low"`): estimates the board's aspect ratio from a camera frame and
  generates instrument Layouts for it (milestone 6). Called only from `server/index.ts`.

## Tap-to-sound latency

Measured per tap as audio onset (audio clock) to Tone trigger time, plus the reported
output latency (unclamped); the median over the last 20 taps is shown in the debug panel,
and the output latency is shown on its own, with a warning above 60 ms (usually Bluetooth
audio). Measured: 66 ms median tap-to-sound, of which 52 ms is output latency. Tone runs
with `latencyHint: "interactive"` and `lookAhead: 0`, and notes trigger at
`Tone.immediate()`, so the rest is the time between the onset block and the trigger.
