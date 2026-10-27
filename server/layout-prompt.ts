// What Muse Spark is asked for when generating a Layout: the instructions, the per-request
// text, and the JSON schema its answer must follow (structured output, strict subset:
// every object closed and fully required, anyOf only below the root). Sounds use anyOf;
// their first keys alphabetically ("note", "sample") are a real choice between them.
import { CONFIG } from "../src/config.ts";
import { DRUM_SAMPLES } from "../src/layout.ts";

export type Corner = { x: number; y: number }; // pixels in the image sent

const closed = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

// One flat object for both shape kinds, not anyOf: the API writes keys in alphabetical
// order, so with anyOf the first key ("h" for a rect, "kind" for a poly) picks the branch,
// and a model that starts with "kind" gets forced into a poly with made-up points.
// toShape turns it back into the Shape union.
const SHAPE = closed({
  kind: { type: "string", enum: ["rect", "poly"] },
  x: { type: "number", description: "rect: left edge, 0-1 across the board (poly: 0)" },
  y: { type: "number", description: "rect: top edge, 0-1 down the board (poly: 0)" },
  w: { type: "number", description: "rect: width (poly: 0)" },
  h: { type: "number", description: "rect: height (poly: 0)" },
  pts: {
    type: "array",
    description: "poly: vertices in order, each [x, y] in 0-1 board coords (rect: [])",
    items: { type: "array", items: { type: "number" } },
  },
});

type WireShape = { kind?: unknown; x?: unknown; y?: unknown; w?: unknown; h?: unknown; pts?: unknown };

// Maps a wire shape to a Shape's fields, unchecked (the browser validates).
function toShape(s: WireShape | null | undefined) {
  if (s?.kind === "poly") return { kind: s.kind, pts: s.pts };
  return { kind: s?.kind, x: s?.x, y: s?.y, w: s?.w, h: s?.h };
}

// The model's zones with their shapes in Layout form; anything malformed is passed on.
export function toZones(zones: unknown): unknown {
  if (!Array.isArray(zones)) return zones;
  return zones.map((z) => (typeof z === "object" && z !== null ? { ...z, shape: toShape(z.shape) } : z));
}

const NOTE = closed({
  type: { type: "string", enum: ["note"] },
  note: { type: "string", description: "scientific pitch, e.g. C4, F#3, Bb5" },
});

const DRUM = closed({
  type: { type: "string", enum: ["drum"] },
  sample: { type: "string", enum: DRUM_SAMPLES },
});

// Reasoning about the aspect comes before the number (alphabetically too, which is the
// order the API writes keys in), so the model looks before it answers.
export const LAYOUT_SCHEMA = closed({
  aspectReasoning: {
    type: "string",
    description: "one or two sentences: what the board is and how its real proportions were judged",
  },
  boardAspect: { type: "number", description: "real-world width / depth of the board" },
  instrument: { type: "string", description: "short instrument name" },
  zones: {
    type: "array",
    items: closed({
      id: { type: "string" },
      label: { type: "string", description: "short text drawn on the zone, e.g. C4 or Snare" },
      shape: SHAPE,
      sound: { anyOf: [NOTE, DRUM] },
    }),
  },
});

export const LAYOUT_INSTRUCTIONS = `You design playable instrument layouts for a desk surface.
A webcam watches the player's hands over a flat board (often a sheet of paper or a desk mat);
fingertip taps on a zone play its sound.

Board coordinates: x and y both run 0-1 over the board, whatever its real shape. x runs from
corner 1 to corner 2 (left to right as the player sees it), y from edge 1-2 to edge 4-3.
So a zone w wide and h deep is (w * boardAspect) : h in real proportions, where boardAspect is
the board's real width / depth. To make a square pad, use w = h / boardAspect.

Rules for zones:
- Every zone lies inside 0-1 on both axes. Zones must not overlap; leaving gaps is fine.
- Every zone is at least ${CONFIG.layoutLimits.minZoneSide} in both w and h, and at most
  ${CONFIG.layoutLimits.maxZones} zones in total. Bigger zones are easier to hit: fill the board.
- Prefer "rect" shapes. Use "poly" (${CONFIG.layoutLimits.maxPolyPts} points at most) only when a
  shape really helps, e.g. round drum heads.
- Pitched instruments use note sounds (scientific pitch like C4, F#3, Bb5, octaves
  ${CONFIG.layoutLimits.noteOctaves[0]}-${CONFIG.layoutLimits.noteOctaves[1]}); all notes play through a piano sampler.
  Percussion uses drum sounds; the only samples are: ${DRUM_SAMPLES.join(", ")}.
- Arrange zones the way the real instrument is laid out, as the player sees the board on
  screen (e.g. low notes on the left).
- Follow the request's details (number of keys, scale, key, range) exactly.
- Labels are short (a note name or a drum name) and ids are unique.`;

export function layoutRequestText(request: string, width: number, height: number, corners: Corner[]): string {
  const list = corners.map((c, i) => `${i + 1}: (${Math.round(c.x)}, ${Math.round(c.y)})`).join(", ");
  return `Requested instrument: "${request}"

The image (${width}x${height}) is the camera frame as the player sees it on screen. The board is
outlined in magenta, corners numbered. Corner pixel positions: ${list}.

1. Estimate the board's real-world aspect ratio (width along edge 1-2 / depth along edge 1-4).
   The outline is seen in perspective, so don't just measure pixels: use what the board is
   (e.g. A4 paper is 1.414 landscape or 0.707 portrait, US Letter 1.294 or 0.773) and the
   perspective cues in the frame.
2. Design the requested instrument's layout for a board of that aspect.`;
}
