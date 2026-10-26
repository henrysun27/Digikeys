# Desk Instrument

Turn any desk into an instrument: a webcam watches your hands over the desk and fingertip
taps play sounds. Built for the Meta Global AI Developer Hackathon (Oct 26 - Nov 4, 2026),
Build for Your World track.

## Run

```
npm install
npm run dev
```

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

## Meta models

None yet (SAM 3.1 and Muse Spark arrive in milestones 5-7).

## Tap-to-sound latency

Measured per tap as audio onset (audio clock) to Tone trigger time, plus output latency;
the median over the last 20 taps is shown in the debug panel. Not recorded here yet.
