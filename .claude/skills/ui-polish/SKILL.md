---
name: ui-polish
description: Visual polish pass on the Digikeys UI. Use when asked to improve how the app looks.
---

# UI polish

A presentation-only pass over the Digikeys UI (`index.html`, `src/style.css`, `src/ui.ts`,
and the Play-view draw functions in `src/main.ts`: `drawLayoutPlay`, `drawObjectsPlay`,
`drawPill`, `drawTipsPlay`, `drawRipples`).

## Hard rules

- **Presentation only.** Never change tap detection (`taps.ts`, `onset-*`, `mic.ts`,
  `shadow*`, `tap-correction.ts`, `hand-*`), audio timing (`sound.ts`, `clock-sync.ts`),
  hit-testing (`hitTest`, `zoneAt`, `zStack` logic in `layout.ts`) or anything under
  `server/` / `/api`. Draw order may change; hit priority may not. If a visual change seems
  to need any of these, stop and ask before touching them.
- **One token file.** Colors, radii, spacing and font live as CSS custom properties in
  `src/style.css` `:root`. Dark theme, one accent `#8B5CF6`, Inter. No new hardcoded colors in
  CSS; add a token instead. Canvas code can't read CSS variables cheaply, so the canvas
  constants in `main.ts` (`ACCENT`, `ACCENT_RGB`, `FONT`) must mirror the tokens; if you
  change a token, change its mirror in the same commit.
- **Play mode keeps the camera stage unobstructed.** No panels, banners or controls over the
  stage in Play; toasts and the setup stepper stay at the edges and get out of the way.
- **Debug stays behind `D` / `?debug`.** Don't surface debug readouts in Play.
- **Keys stay translucent, objects draw on top.** Natural keys ~15-20% fill, sharps ~35-45%,
  the desk and hands visible underneath; crisp outlines and labels; strong hit glow. Object
  pads are drawn above all keys (keys clipped out beneath them) with their outline and pill
  fully visible. Render order: keys -> sharps -> objects -> fingertips -> hit effects.
- **Text contrast passes WCAG AA**: 4.5:1 for body text, 3:1 for large text (>= 24px, or
  >= 18.66px bold) and UI component boundaries. Compute it against the actual background
  (for canvas labels, assume a mid-grey desk, `#808080`, unless a halo/pill backs the text).
- **Check layout at 1280x720 and 1920x1080** window sizes: nothing clipped, overlapping or
  scrolling horizontally, stage fills its area, controls reachable.

## Process

1. **Survey first.** Read `src/style.css`, `index.html`, `src/ui.ts` and the Play draw
   functions. If the app can run, look at it (Play and Debug) at both window sizes.
2. **List the 5 highest-impact visual problems** to the user before fixing anything, each
   with where it lives (`file:line`) and why it matters for a demo. Rank by how much a viewer
   would notice.
3. **Fix them**, within the rules above. Prefer token changes over one-off overrides.
4. **Verify**: `npx tsc --noEmit -p .` and `npm run build` must both pass. Re-check the two
   window sizes and AA contrast for any text whose colors changed.
5. **Commit** with a `ui:` prefix (e.g. `ui: tighten setup stepper, AA-contrast muted text`),
   staging only the files you changed, then **push**.
6. **Tell the user exactly what to look at**: for each fix, the view (Play/Debug), the step
   or state to reach it (e.g. "after calibration, with an object scanned"), and what should
   look different. Say plainly what you could not verify yourself (e.g. on-camera rendering).
