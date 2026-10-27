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
