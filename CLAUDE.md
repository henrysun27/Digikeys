@'

\# Desk Instrument



Meta Global AI Developer Hackathon (Oct 26 - Nov 4, 2026), Build your own world track.



Turn any desk into an instrument. A webcam watches hands over the desk. SAM 3.1 finds the

playing surface and objects on it, Muse Spark generates an instrument layout that fits the

surface, and fingertip taps (mic onset fused with hand tracking) play sounds.



All code in this repo is written during the hackathon. Never copy code from other projects.



\## Stack

\- Vite + vanilla TS, MediaPipe HandLandmarker (GPU, VIDEO mode), Canvas overlay, Tone.js.

\- Serve MediaPipe wasm + model from own origin (copy/download in a predev script, gitignored).

\- Meta Model API calls go through a minimal Node server in `server/`, never from the browser.

&#x20; API key lives in `.env` (gitignored); commit `.env.example`. `npm run dev` starts both

&#x20; Vite and the server (e.g. with `concurrently`).

\- `.gitattributes`: `\* text=auto eol=lf`.



\## Core data model (use from milestone 2 on)

Everything playable is a Zone in board coordinates (0-1 after the homography):



```ts

type Shape =

&#x20; | { kind: "rect"; x: number; y: number; w: number; h: number }

&#x20; | { kind: "poly"; pts: \[number, number]\[] };

type Sound =

&#x20; | { type: "note"; note: string }      // e.g. "C4"

&#x20; | { type: "drum"; sample: string };   // e.g. "snare"

type Zone = { id: string; label: string; shape: Shape; sound: Sound };

type Layout = { instrument: string; zones: Zone\[] };

```



The piano is just the first Layout (`PIANO\_LAYOUT`, 2x7 keys). Hit-testing, rendering and

sound all read from the active Layout; never hardcode keys anywhere else. Milestones 6-7

generate Layouts from Meta models, so this must stay generic.



\## Milestones (one at a time, commit after each)

1\. Webcam feed + hand landmarks drawn on canvas (mirrored view).

2\. Calibration + layout: click 4 corners (numbered dots, reset button, reject

&#x20;  crossed/collinear), homography, render PIANO\_LAYOUT warped onto the desk, highlight the

&#x20;  zone under each fingertip, save calibration to localStorage.

3\. Tap detection: mic onset (adaptive floor + sudden-rise check, \~80ms refractory) fused

&#x20;  with fingertip history (\~200ms). On onset, pick the finger that moved down fastest then

&#x20;  stopped. Debug panel: mic level, threshold, chosen finger, stop offset.

4\. Sound: Tone.js piano + drum samples. Trigger on the audio onset using the best-guess

&#x20;  finger (don't wait for the stop). Measure and show tap-to-sound latency in the debug panel.

5\. Meta server + SAM 3.1 boundary: capture a frame, server sends it to SAM 3.1, take the

&#x20;  boundary mask, fit 4 corners (or a polygon), feed the same homography path. Click

&#x20;  calibration stays as the fallback.

6\. Muse Spark layouts: user says or picks an instrument (Muse Voice Transcribe for speech).

&#x20;  Server sends the request + board aspect ratio + a desk frame to Muse Spark, asking for

&#x20;  Layout JSON. Validate before use (zones inside 0-1, no overlaps, minimum size); fall back

&#x20;  to a preset on bad output.

7\. Object pads: SAM 3.1 segments objects on the desk; Muse Spark looks at each crop and

&#x20;  assigns a fitting sound (ceramic mug -> bell, notebook -> snare). Each object becomes a

&#x20;  poly Zone.

8\. MIDI out (Web MIDI API) so taps can drive GarageBand/Ableton.



Before writing milestone 5-7 code, read the Meta docs (https://dev.meta.ai/docs) and the

cookbook (https://github.com/meta-models/meta-model-cookbook) for exact model IDs,

endpoints and request formats. Don't guess them.



\## Config

All tunables live in one config object: onset params, refractory, finger-history window,

videoLagMs, validation limits.



\## README (keep updated)

Note which features were built during the hackathon, which Meta models are used and where,

and the measured tap-to-sound latency.

'@ | Set-Content -Path CLAUDE.md -Encoding utf8

