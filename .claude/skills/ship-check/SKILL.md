---
name: ship-check
description: Pre-submission check. Use before demos, deploys, or submitting.
---

# Ship check

Run every step, then report a pass/fail checklist. Fix only trivial failures (a stale
`.env.example` line, a missing README sentence, an unpushed commit, a one-line type error).
Anything bigger: report it as FAIL with the cause and a proposed fix, and leave it.

## Steps

1. **Typecheck and build, client and server.**
   - `npx tsc --noEmit -p .` (client) and `npx tsc --noEmit -p server` (server).
   - `npm run build` (runs `tsc && tsc -p server && vite build`; `prebuild` fetches the
     MediaPipe assets).

2. **Server endpoints with a sample image.**
   - Start the API in the background: `npm run server` (listens on `127.0.0.1:8787`,
     `CONFIG.server.port`). If the port is busy, an instance is probably already running; use
     it rather than killing it.
   - Make a sample: a small JPEG of a desk-like scene (use a frame from the repo if one exists,
     else generate one) encoded as a `data:image/jpeg;base64,...` URL. Keep it small (< 200 KB).
   - Call each route and record status + `ms`:
     - `GET /api/health` -> `{ ok: true, apiKey: true }`. `apiKey: false` means `.env` is
       missing `MODEL_API_KEY`: FAIL, and skip the model calls below.
     - `POST /api/segment` `{ image, prompt: "desk" }` (SAM 3.1)
     - `POST /api/surfaces/list` `{ image }` (Muse Spark)
     - `POST /api/objects/list` `{ image }` (Muse Spark)
     - `POST /api/objects/segment` `{ image, prompts: ["mug"] }` (SAM 3.1)
     - `POST /api/objects/describe` `{ image, prompt: "mug" }` (Muse Spark)
     - `POST /api/layout` `{ image, request: "piano", width, height, corners: [4 x {x, y}],
       orientation: { near, left } }` (Muse Spark; `near`/`left` are adjacent edges from
       `EDGES` in `src/orientation.ts`, corners are pixel positions inside the image)
     - `POST /api/transcribe` with a short WAV body (Muse Voice Transcribe; generate ~1 s of
       16-bit PCM silence or a tone; an empty transcript is fine, a 4xx/5xx is not)
     - `POST /api/sessions` `{ "kind": "digikeys-session" }` (local, no model; writes a
       file to `sessions/`, delete the one you made)
   - A 200 with a well-formed body passes. Report empty results (e.g. no objects found) as a
     note, not a failure. Stop the server you started when done.
   - Never print the API key or full request/response bodies containing it.

3. **Secrets.**
   - `git ls-files .env` must print nothing and `git check-ignore .env` must match.
   - `git log --all --oneline -- .env` must be empty (never committed).
   - `.env.example` lists every `process.env.*` the server reads
     (`grep -rhoE "process\.env\.\w+" server src | sort -u`), with no real values.

4. **Git.** `git status --porcelain` is empty and `git status -sb` shows no ahead/behind
   versus the upstream. Untracked files the user didn't create in this task: report, don't
   delete or commit them without asking.

5. **README** covers, accurately against the code:
   - what was built during the hackathon (Oct 26 - Nov 4, 2026),
   - which Meta models are used and where (SAM 3.1, Muse Spark, Muse Voice Transcribe, with
     the feature each one drives; model IDs match `CONFIG` / `server/`),
   - measured tap-to-sound latency and tap accuracy (numbers, how and when measured),
   - how to run it (`npm install`, `.env` from `.env.example`, `npm run dev`, browser and
     camera/mic requirements).

## Report

A checklist, one line per item, `PASS` / `FAIL` / `FIXED` / `SKIPPED (why)`:

```
[PASS]  client typecheck
[PASS]  server typecheck
[PASS]  build
[PASS]  GET  /api/health              apiKey: true
[PASS]  POST /api/segment             200, 1840 ms
...
[FIXED] .env.example missing FOO      added
[FAIL]  README latency                no measured number; proposed: ...
```

Then list every fix made (file + one line) and whether it was committed and pushed.
