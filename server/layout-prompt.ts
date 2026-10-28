// What Muse Spark is asked for when generating a Layout: the instructions, the per-request
// text, and the JSON schema its answer must follow (structured output, strict subset:
// every object closed and fully required, anyOf only below the root). Sounds use anyOf;
// their first keys alphabetically ("note", "sample") are a real choice between them.
import { CONFIG } from "../src/config.ts";
import { DRUM_SAMPLES } from "../src/layout.ts";
import { playerCorners, type Orientation } from "../src/orientation.ts";

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
  x: { type: "number", description: "rect: left side, 0-1 from the player's left to right (poly: 0)" },
  y: { type: "number", description: "rect: far side, 0-1 from the far edge to the near edge (poly: 0)" },
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
  boardAspect: {
    type: "number",
    description: "real-world width (along the player's edge) / depth (from the player's edge to the far edge)",
  },
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

const { minZoneSide, minZoneWidth, maxZones, maxPolyPts, noteOctaves } = CONFIG.layoutLimits;
const maxAcross = Math.floor(1 / minZoneWidth + 1e-9);

export const LAYOUT_INSTRUCTIONS = `You design playable instrument layouts for a desk surface.
A webcam watches the player's hands over a flat board (often a sheet of paper or a desk mat);
fingertip taps on a zone play its sound.

Coordinates are in the player's frame, whatever the camera sees: x runs 0-1 from the
player's left to their right along the edge they sit at (the near edge); y runs 0-1 from the
far edge (y = 0) to the near edge (y = 1). So a zone w wide and h deep is (w * boardAspect) : h
in real proportions, where boardAspect is the board's real width (along the near edge) / depth.
To make a square pad, use w = h / boardAspect.

Rules for zones:
- Every zone lies inside 0-1 on both axes. Zones must not overlap; leaving gaps is fine.
- Every zone is at least ${minZoneWidth} wide in x (about one finger) and at least ${minZoneSide}
  deep in y, with at most ${maxZones} zones in total. So at most ${maxAcross} zones fit side by
  side in a row: choose the range to fit. A piano gets about one octave (8 white keys, C to C,
  plus its sharps), not two, even if the request asks for more; use C4 to C5 unless the
  request names a range. Bigger zones are easier to hit: fill the board.
- Prefer "rect" shapes. Use "poly" (${maxPolyPts} points at most) only when a shape really helps,
  e.g. round drum heads or white keys notched around black keys.
- Pitched instruments use note sounds (scientific pitch like C4, F#3, Bb5, octaves
  ${noteOctaves[0]}-${noteOctaves[1]}); all notes play through a piano sampler.
  Percussion uses drum sounds; the only samples are: ${DRUM_SAMPLES.join(", ")}.
- Arrange zones the way the real instrument is laid out as the player sits at it: low notes on
  the player's left (small x), high notes on their right. On a keyboard, the white keys reach
  the near edge and the sharps/flats (black keys) sit on the FAR side (small y, e.g. y 0 to
  0.5) between the white keys they belong to, each black key also at least ${minZoneWidth} wide;
  white keys go around them (notched polys) or only cover the near part, never overlapping.
  A drum kit is laid out like a real kit from the drummer's seat.
- Follow the request's details (number of keys, scale, key, range) as far as the width
  limit allows.
- Labels are short (a note name or a drum name) and ids are unique.`;

export function layoutRequestText(
  request: string,
  width: number,
  height: number,
  corners: Corner[],
  orientation: Orientation,
): string {
  const list = corners.map((c, i) => `${i + 1}: (${Math.round(c.x)}, ${Math.round(c.y)})`).join(", ");
  const pc = playerCorners(orientation);
  return `Requested instrument: "${request}"

The image (${width}x${height}) is the camera frame as shown on screen (mirrored). The board is
outlined in magenta, corners numbered. Corner pixel positions: ${list}.

The player sits at edge ${orientation.near} (the near edge); their left is edge ${orientation.left}. In the
player's frame, corner ${pc.farLeft} is (0, 0) far left, corner ${pc.farRight} is (1, 0) far right, corner ${pc.nearRight}
is (1, 1) near right and corner ${pc.nearLeft} is (0, 1) near left.

1. Estimate the board's real-world aspect ratio (width along the near edge / depth from the
   near edge to the far edge). The outline is seen in perspective, so don't just measure
   pixels: use what the board is (e.g. A4 paper is 1.414 or 0.707, US Letter 1.294 or 0.773,
   depending on which way it lies) and the perspective cues in the frame.
2. Design the requested instrument's layout for a board of that aspect, in the player's frame.`;
}
