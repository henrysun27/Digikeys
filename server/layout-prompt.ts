// What Muse Spark is asked for when generating an instrument: the instructions, the
// per-request text, and the JSON schema its answer (an InstrumentSpec, src/instrument.ts)
// must follow (structured output, strict subset: every object closed and fully required,
// anyOf only below the root). Sounds use anyOf; their first keys alphabetically ("note",
// "sample") are a real choice between them. The browser's layout engine builds the zones,
// except for "freeform" specs, whose zones the model places.
import { CONFIG } from "../src/config.ts";
import { SCALE_NAMES, SPEC_KINDS } from "../src/instrument.ts";
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

// Keys are written in alphabetical order by the API.
export const LAYOUT_SCHEMA = closed({
  boardAspect: {
    type: "number",
    description: "real-world width (along the player's edge) / depth (from the player's edge to the far edge)",
  },
  includeSharps: { type: "boolean", description: "keyboard with chromatic scale: true adds the black keys" },
  instrument: { type: "string", description: "short instrument name" },
  kind: { type: "string", enum: SPEC_KINDS },
  notes: {
    type: "string",
    description: "a few words on any compromise or assumption the player should know, else empty",
  },
  noteRange: closed({
    low: { type: "string", description: 'lowest note, scientific pitch like C4 ("" if unused)' },
    high: { type: "string", description: 'highest note, e.g. B5 ("" if unused)' },
  }),
  root: { type: "string", description: "scale root pitch class, e.g. C, G, F#, Bb" },
  rows: { type: "integer", description: "pads: rows of the grid (keyboard: 1)" },
  scale: { type: "string", enum: SCALE_NAMES },
  sounds: {
    type: "array",
    description: "pads: one sound per pad, far-left first, row by row ([] to use noteRange + scale)",
    items: { anyOf: [NOTE, DRUM] },
  },
  zones: {
    type: "array",
    description: "freeform only: every zone, placed by you ([] otherwise)",
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

export const LAYOUT_INSTRUCTIONS = `You turn an instrument request into a spec for a desk instrument.
A webcam watches the player's hands over a flat board (often a sheet of paper or a desk mat);
fingertip taps on a zone play its sound. Code builds the zones from your spec: you decide what
to build, not where each zone goes.

Kinds:
- "keyboard": keys side by side, low notes on the player's left. The notes are every note from
  noteRange.low to noteRange.high that is in the scale (root + scale). Scale "chromatic" with
  includeSharps true is a piano: white keys reach the near edge, black keys sit on the far side
  between them. Chromatic without sharps is the white keys only. Any other scale gives one
  equal key per scale note (includeSharps is ignored). For xylophones, marimbas, kalimbas,
  scale keyboards.
- "pads": an even grid with \`rows\` rows, filled row by row from the far left. Pads play
  \`sounds\` in that order; leave sounds empty to use the noteRange + scale notes instead. For
  drum kits (far row toms high to low, near row hi-hat, snare, kick), drum pads, note pads.
- "freeform": only when neither fits; you then place every zone in \`zones\` (rules below).

Explicit requests win. Build exactly what was asked: a "two octave keyboard" is two octaves
(e.g. C4 to B5), never one; "8 keys" is 8 keys. About ${maxAcross} zones fit side by side at a
comfortable finger width; when the request needs more, still build it and say so in \`notes\`
in a few words, e.g. "2 octaves: keys are narrow on this board". Never shrink a request
quietly. At most ${maxZones} zones in total.

When the request leaves things open, choose what plays well here: a piano is C4 to C5 with
sharps (one octave fits comfortably); a pitched percussion instrument is one or two octaves of
a fitting scale; pads have about as many columns as fit comfortably. Mention real assumptions
in notes (e.g. "C major pentatonic"), otherwise leave notes empty.

Sounds: all notes play through a piano sampler (scientific pitch like C4, F#3, Bb5, octaves
${noteOctaves[0]}-${noteOctaves[1]}). The only drum samples are: ${DRUM_SAMPLES.join(", ")}. Fields a kind doesn't
use still need a value: noteRange "" and "", rows 1, sounds [], zones [], root "C".

Freeform zones only: coordinates are in the player's frame. x runs 0-1 from the player's left
to right along the near edge; y runs 0-1 from the far edge (0) to the near edge (1). A zone w
wide and h deep is (w * boardAspect) : h in real proportions, so a square is w = h / boardAspect.
Zones lie inside 0-1, don't overlap, are at least ${minZoneWidth} wide and ${minZoneSide} deep. Prefer
"rect"; "poly" (${maxPolyPts} points at most) only when a shape really helps. Labels are short, ids unique.`;
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

boardAspect: the board's real width along the near edge / depth. It is seen in perspective,
so judge from what it is (A4 paper lies as 1.414 or 0.707, US Letter as 1.294 or 0.773).
Then write the spec.`;
}
