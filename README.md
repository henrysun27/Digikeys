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
- [x] Milestone 6: type an instrument ("drum kit", "8-key
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
      generated layout joins the instrument picker. Generation took about 5-15 s; Muse Spark
      now returns an InstrumentSpec instead of zones (see "Instrument specs" below).
      The shape schema is one flat object with `kind` plus all fields rather than an
      `anyOf` of rect and poly: the API writes keys in alphabetical order, so with `anyOf`
      the first key picked the branch and a model starting with `kind` was forced into a
      polygon with made-up points (2 of 4 piano requests came back that way).
- [x] Milestone 6 voice input: hold Space (outside the text boxes) or hold "Hold to talk"
      and say an instrument, up to 5 s. The mic is recorded in an AudioWorklet
      (`src/voice-worklet.ts`), resampled to 16 kHz mono through an OfflineAudioContext
      with a low-pass, boosted up to 8x if quiet (the mic runs with auto gain off for the
      onset detector), and sent as a 16-bit WAV to `POST /api/transcribe`, which forwards it
      to Muse Voice Transcribe in PUSH_TO_TALK mode with a few instrument names as keyword
      bias. The transcript fills the instrument box and Generate runs on it. Tap detection
      (mic onsets and vision stops) is paused from the press until 400 ms after the
      release, so speech and the released key's click don't play notes. The layout status
      line shows the transcript and timings (audio length, WAV encoding, transcription,
      round trip), then the Muse Spark result. A 1.8 s clip took about 1.2 s to transcribe.
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
      strikes only if its down-stroke went at least `CONFIG.taps.minStrokeDepth` (then 0.03)
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
- [x] Onsets that ignore background noise (`src/onset-detector.ts`, run by the worklet):
      the floor is the running median of the block level over the last second
      (`onset.floorWindowMs`), not a minimum tracker, which had sat 8 dB below a
      fluctuating background and put the threshold inside it. An onset needs the level
      8 dB over the floor and a transient: at least `minRiseDb` (8) over the RMS of the
      50 ms before the last 10 ms. On recorded-style test noise whose level jumps +-6 dB
      every 5-20 ms (-31 dBFS), the old detector fired 4.8 onsets/s with no taps, the new
      one none; synthetic taps 14 dB or more over the background are all found, taps only
      10 dB over about half the time. Rejected onsets show their rise in the tap log.
      `minStrokeDepth` is now 0.02 (real presses measured about 0.025).
- [x] Detection rate. Profiled in headless Edge with a fake camera (two hands moving) and
      mic. The two-hand/chord changes add about 0.05-0.08 ms of main-thread work per hand
      result and nothing in the worker; the old and new code detect at the same rate under
      the same load. What sets the rate is the GPU MediaPipe gets and what else uses it:
      - The browser ran MediaPipe on the Intel integrated GPU, not the laptop's RTX 5060.
        Two moving hands took 12-25 ms per frame in isolation on Intel (it varied 2x
        between sessions), 35 ms in the app, versus 5-6 ms in isolation and 7.5-9 ms in
        the app (30/s, the camera's rate) on the RTX. Setting the browser to "High
        performance" in Windows Settings > System > Display > Graphics moves it.
      - Wallpaper Engine was using about half of the Intel GPU's 3D engine.
      - The canvas redrew on every animation frame, 240/s on the 240 Hz panel, each a full
        1280x720 video copy. It now redraws only when a new video frame or new hand result
        has arrived (about 45-60/s). With the browser's frame rate unlimited, the old loop
        redrew ~3000/s and starved detection entirely; the new one held 30/s.
      The status line shows the main thread's time per hand result, redraws per second
      and time per redraw, next to the detection rate and time in the debug panel.
- [x] Instrument specs and a layout engine: "two octave keyboard" used to come back as one
      octave (13 zones), because the width cap overrode the request without saying so, and
      Muse Spark spent 12.7 s placing geometry by hand. Now Muse Spark returns an
      InstrumentSpec (`kind` keyboard/pads/freeform, `noteRange`, `scale` + `root`,
      `includeSharps`, `rows`, `sounds`, `notes` explaining any compromise) and
      `src/instrument.ts` builds the zones from it deterministically. Keyboard: the notes of
      the scale in the range; chromatic with sharps is a piano (white keys to the near edge,
      black keys on the far half centered on the boundaries, white keys notched around them;
      black key width is `minZoneWidth` kept within 0.5-0.7 of a white key), chromatic
      without sharps is the white keys, any other scale one equal key per note (flat-key
      roots are labeled with flats). Pads: an even grid of `rows` rows, a short last row
      centered, playing `sounds` or the scale's notes. Only "freeform" specs carry zones
      placed by Muse Spark (for a ring-shaped steel drum, say), and only those need a
      plausible board aspect. Explicit requests win: zones narrower than `minZoneWidth` are
      built anyway, and the status line shows Muse Spark's `notes` ("2 octaves: keys are
      narrow on this board") and the measured warning ("10 of 24 zones are narrower than a
      finger"). Depth, area, overlap and count (now 49, a 4-octave piano) are still hard
      limits. The presets are specs built by the same engine (geometry identical to the old
      hand-built ones). The status line shows the spec, Muse Spark's time and tokens. With
      `reasoning_effort: "minimal"` and 4000 max tokens, keyboard and pad specs took
      2.8-3.9 s (270-590 reasoning tokens) on a synthetic desk frame, against 3.5-6.1 s with
      "low" for the same specs; freeform layouts took 4.4-6.6 s.
- [x] Zone z-order: every Zone has a `z`; where zones overlap, the highest z wins the
      hit-test (regardless of zone order) and is drawn on top. The engine's pianos now
      use full-depth white key rects at z 0 with the black keys over them at z 1, instead
      of white keys notched around the black keys. `checkLayout` allows overlaps between
      different z, still rejects them within the same z, and requires each zone's part
      left uncovered by higher zones to meet `minZoneArea`. Freeform zones from Muse Spark
      carry `z` too (asked for a toy piano with black keys on top, it returned exactly
      that: white keys z 0, black keys z 1). Zones are drawn low z first, each clipped
      to what higher zones leave visible, and labels, the tap-calibration crosshair and
      its fit target sit at the middle of each zone's visible part (`zoneAnchor`), so a
      white key's label and target are on its uncovered near part.

## Meta models

- **SAM 3.1** (`sam-3.1`, Responses API at `https://api.meta.ai/v1/responses`, streamed,
  one-bit masks): finds the playing surface in a camera frame (milestone 5). Called only
  from `server/index.ts`; the output is parsed with Meta's `@meta-sam/parser`.
- **Muse Spark 1.3** (`muse-spark-1.3`, Chat Completions at
  `https://api.meta.ai/v1/chat/completions`, image input, `response_format` JSON schema,
  `reasoning_effort: "minimal"`): estimates the board's aspect ratio from a camera frame and
  turns the instrument request into an InstrumentSpec, which `src/instrument.ts` builds
  into a Layout (milestone 6). Called only from `server/index.ts`.
- **Muse Voice Transcribe** (`muse-voice-transcribe-1.0`, `POST
  https://api.meta.ai/v1/asr/transcribe`, multipart: a JSON `request` part and a 16 kHz mono
  16-bit WAV `audio` part, PUSH_TO_TALK mode): turns the spoken instrument request into
  text (milestone 6). Called only from `server/index.ts`.

## Tap-to-sound latency

Measured per tap as audio onset (audio clock) to Tone trigger time, plus the reported
output latency (unclamped); the median over the last 20 taps is shown in the debug panel,
and the output latency is shown on its own, with a warning above 60 ms (usually Bluetooth
audio). Measured: 66 ms median tap-to-sound, of which 52 ms is output latency. Tone runs
with `latencyHint: "interactive"` and `lookAhead: 0`, and notes trigger at
`Tone.immediate()`, so the rest is the time between the onset block and the trigger.
- [x] Wider stop window: real taps were rejected as "stopped too early" at -204 to -265 ms.
      A finger's stop now counts from 300 ms before to 150 ms after onset + `videoLagMs`
      (`CONFIG.taps.stopWindowMs`, was +-150 ms), for both the instant guess and the
      check. The window is set for the camera's nominal 30 fps and stretches by the
      measured frame interval over nominal (never shrinks), so it stays valid if the frame
      rate drops: at 15 fps it is -600 to +300 ms. Below 25 measured fps
      (`camera.lowFpsWarn`) the debug panel warns "low light? camera fps dropped".
- [x] Player orientation (`src/orientation.ts`). Which board edge the player sits at is
      detected from hand pose: a wrist is nearer the player than its fingertips, so each
      hand frame over the board votes with its fingertips-to-wrist direction (board
      coords). Over 3 s (`CONFIG.player`) the mean picks the edge once 30 frames agree
      (mean unit vector length at least 0.5), and it is stored in `CONFIG.playerEdge`.
      Until then the edge nearest the top of the camera image is assumed, where a laptop
      webcam facing the player sees them. The player's left follows from the edge and the
      board mapping's handedness (the camera sees the desk from above; clicked corners
      follow the mirrored view). The debug panel's "Player edge" row shows the near and
      left edges, where they are on screen, and whether they come from the hands.
      Layouts are now written in the player's frame (x from their left to right, y from
      the far edge to the near edge) and placed on the board by `orientLayout`; they are
      re-placed when the edge changes, and new corners forget it.
      - The piano preset is one octave, C4 to C5, with low notes on the player's left and
        the five sharps on the far half of the board (drawn dark), white keys notched
        around them. The drum preset has the toms across the far side and hi-hat, snare
        and kick nearest the player.
      - Muse Spark gets the near and left edges and which numbered corner is far-left,
        far-right, near-right and near-left, and designs in the player's frame: low notes
        on the left, black keys on the far side.
- [x] Zone width cap: every zone must be at least `layoutLimits.minZoneWidth` (0.07 of the
      board width, about a finger) wide across the player's view. The prompt states the
      resulting cap (14 zones side by side, so a piano gets one octave, not two) and
      `checkLayout` rejected narrower zones (now a warning: see "Instrument specs"). Asked for "piano" on a synthetic A4-landscape
      frame, Muse Spark (10 s) returned C4-C5 with the sharps 0.07 wide on the far side,
      which passed the checks and lands low notes on the screen's left and sharps at the
      bottom for a player at the top of the image.
- [x] Vision-only taps use the same strike test as hybrid (`minStrokeDepth`,
      `minStrikeSpeed`, a stop) and now also need the stop to hold: the finger must stay
      still (speed either way under `stopSpeedRatio` of the stroke's peak) for
      `taps.visionHoldFrames` (2) frames after the stop frame, so a finger bouncing
      straight back up doesn't play. That adds about 2 frames (67 ms at 30 fps) to vision
      tap latency. Hybrid stays the default.
- [x] Off-board guesses: taps #152-157 played nothing because the instant guess picked a
      finger whose projected landing point was off the board (silent), while the other
      index finger was striking on the board and the stop check found A+B chords there.
      Fingers whose landing point (after tap correction) is outside the board are no longer
      chord candidates, for the guess and the check alike, and the chord ratio is taken
      against the best on-board finger. The tap log lists them as "lands off board (x, y)".
      `chordRatio` is now 0.4: real chord fingers scored 0.45-0.53 of the best and were
      blocked at 0.8. Each chord note still has to pass the strike test on its own.
