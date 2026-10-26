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

## Meta models

None yet (SAM 3.1 and Muse Spark arrive in milestones 5-7).

## Tap-to-sound latency

Not measured yet (milestone 4).
