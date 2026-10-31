// What Muse Spark is asked when Detect surface runs with no prompt: the flat surfaces in view
// that could be the playing area, best first, each a name for SAM 3.1 and a short reason.
// Structured output (strict: closed objects, every key required); the browser checks the
// answer (checkSurfaceList in src/surface-scan.ts).
import { CONFIG } from "../src/config.ts";

export const SURFACE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["surfaces"],
  properties: {
    surfaces: {
      type: "array",
      description: "best playing area first",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "reason"],
        properties: {
          name: { type: "string", description: "a short common noun phrase, e.g. sheet of paper, desk mat" },
          reason: { type: "string", description: "why it suits or its drawback, at most 6 words, lowercase" },
        },
      },
    },
  },
};

export const SURFACE_INSTRUCTIONS = `You pick the playing area for a tabletop instrument. A webcam looks down at a desk; the
player will tap on a flat surface and the app draws keys or pads onto it.

List the flat surfaces in view that could serve as the playing area: a sheet of paper, a desk
mat, a mouse pad, a notebook or sketchbook lying open or closed, a placemat, a large book, a
cutting board, or the bare desk itself. Leave out hands, arms and people, screens, keyboards
and anything tall or not flat (mugs, bottles, lamps, phones standing up).

Rank them best first. A good playing area is flat, has all four edges visible (not cut off by
the frame or hidden under something), is large enough for several fingers side by side (about
a fifth of the frame or more), and is not covered by other objects.

Each name is the text prompt for an image segmenter, which finds every instance of a phrase:
use a short common noun phrase it would know ("desk mat" rather than a brand), add a color or
material only to tell two surfaces apart ("white paper", "black desk mat"), and never list the
same surface under two names. Each reason says why it suits or what its drawback is, in at
most 6 lowercase words, e.g. "largest, clean edges" or "small but fully visible".
At most ${CONFIG.sam.autoSurface.maxCandidates} surfaces; an empty list if nothing flat is in view.`;
