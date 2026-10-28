// The layout engine: Muse Spark answers with an InstrumentSpec (what to build) and the code
// here builds its Zones deterministically. Only a "freeform" spec carries zones placed by
// the model. The presets are specs too.
import { CONFIG } from "./config.ts";
import { checkLayout, checkSound, type Layout, type Shape, type Sound, type Zone } from "./layout.ts";

// Semitones above the root.
export const SCALES = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  "harmonic minor": [0, 2, 3, 5, 7, 8, 11],
  "major pentatonic": [0, 2, 4, 7, 9],
  "minor pentatonic": [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  "whole tone": [0, 2, 4, 6, 8, 10],
} satisfies Record<string, number[]>;
export type Scale = keyof typeof SCALES;
export const SCALE_NAMES = Object.keys(SCALES) as Scale[];
export const SPEC_KINDS = ["keyboard", "pads", "freeform"] as const;

// keyboard: every note from noteRange.low to .high in the scale, low notes on the player's
//   left. Chromatic with includeSharps is a piano (white keys to the near edge, black keys
//   on the far side over the boundaries); chromatic without is the white keys only; any
//   other scale is one equal full-depth key per note.
// pads: an even grid of `rows` rows, filled from the far left, playing `sounds` in order,
//   or the noteRange + scale notes if sounds is empty.
// freeform: the model's own `zones`.
// notes: the model's explanation of any compromise or assumption, shown to the player.
export type InstrumentSpec = {
  kind: (typeof SPEC_KINDS)[number];
  instrument: string;
  noteRange: { low: string; high: string } | null;
  scale: Scale;
  root: string; // pitch class, e.g. "C", "F#", "Bb"
  includeSharps: boolean;
  rows: number;
  sounds: Sound[];
  notes: string;
  zones: unknown; // freeform only, unchecked until checkLayout
};

const PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_CLASSES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const LETTERS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const isBlack = (midi: number) => PITCH_CLASSES[midi % 12].length > 1;
// Sharps, or flats for a scale whose root is spelled with one.
const noteName = (midi: number, flats = false) =>
  `${(flats ? FLAT_CLASSES : PITCH_CLASSES)[midi % 12]}${Math.floor(midi / 12) - 1}`;

function pitchClass(s: string): number | null {
  const m = /^([A-G])(#|b)?$/.exec(s.trim());
  return m ? (LETTERS[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + 12) % 12 : null;
}

// Scientific pitch to MIDI number, within CONFIG.layoutLimits.noteOctaves.
function midi(s: string): number | null {
  const m = /^([A-G](?:#|b)?)(\d)$/.exec(s.trim());
  const [lo, hi] = CONFIG.layoutLimits.noteOctaves;
  if (!m || Number(m[2]) < lo || Number(m[2]) > hi) return null;
  return (Number(m[2]) + 1) * 12 + LETTERS[m[1][0]] + (m[1][1] === "#" ? 1 : m[1][1] === "b" ? -1 : 0);
}

const DRUM_LABELS: Record<string, string> = {
  kick: "Kick",
  snare: "Snare",
  hihat: "Hi-hat",
  tom1: "Tom 1",
  tom2: "Tom 2",
  tom3: "Tom 3",
};

// Zones with unique ids (the sound's name, suffixed on repeats).
function zonesOf(cells: { sound: Sound; shape: Shape }[]): Zone[] {
  const ids = new Set<string>();
  return cells.map(({ sound, shape }) => {
    const name = sound.type === "note" ? sound.note : sound.sample;
    let id = name;
    for (let n = 2; ids.has(id); n++) id = `${name}-${n}`;
    ids.add(id);
    const label = sound.type === "note" ? sound.note : (DRUM_LABELS[sound.sample] ?? sound.sample);
    return { id, label, shape, sound };
  });
}

const note = (m: number, flats = false): Sound => ({ type: "note", note: noteName(m, flats) });
const rect = (x: number, y: number, w: number, h: number): Shape => ({ kind: "rect", x, y, w, h });

// A piano from lo to hi, widened to start and end on white keys: white keys the full depth,
// black keys over the far part of the boundaries, white keys notched around them so no
// zones overlap.
function piano(lo: number, hi: number): Zone[] {
  if (isBlack(lo)) lo--;
  if (isBlack(hi)) hi++;
  const whites: number[] = [];
  for (let m = lo; m <= hi; m++) if (!isBlack(m)) whites.push(m);
  const kw = 1 / whites.length;
  const { blackKeyDepth: depth, blackKeyWidth } = CONFIG.keyboard;
  const bw = Math.min(blackKeyWidth[1] * kw, Math.max(blackKeyWidth[0] * kw, CONFIG.layoutLimits.minZoneWidth));
  const sharpAfter = (m: number) => m < hi && isBlack(m + 1);
  const cells = whites.map((m, i) => {
    const x0 = i * kw;
    const x1 = x0 + kw;
    const l = i > 0 && sharpAfter(whites[i - 1]) ? bw / 2 : 0; // notch on the left...
    const r = sharpAfter(m) ? bw / 2 : 0; // ...and right
    const pts: [number, number][] = [[x0 + l, 0], [x1 - r, 0]];
    if (r) pts.push([x1 - r, depth], [x1, depth]);
    pts.push([x1, 1], [x0, 1]);
    if (l) pts.push([x0, depth], [x0 + l, depth]);
    return { sound: note(m), shape: { kind: "poly", pts } as Shape };
  });
  whites.forEach((m, i) => {
    if (sharpAfter(m)) cells.push({ sound: note(m + 1), shape: rect((i + 1) * kw - bw / 2, 0, bw, depth) });
  });
  return zonesOf(cells);
}

// Equal full-depth keys side by side.
function keys(notes: number[], flats: boolean): Zone[] {
  const w = 1 / notes.length;
  return zonesOf(notes.map((m, i) => ({ sound: note(m, flats), shape: rect(i * w, 0, w, 1) })));
}

// Columns for n pads in about `rows` rows, and the rows that then get filled.
function gridSize(n: number, rows: number) {
  const cols = Math.ceil(n / Math.min(n, Math.max(1, Math.round(rows))));
  return { cols, rows: Math.ceil(n / cols) };
}

// An even grid, rows far to near; a short last row is centered.
function pads(sounds: Sound[], rows: number): Zone[] {
  const n = sounds.length;
  const { cols, rows: used } = gridSize(n, rows);
  return zonesOf(
    sounds.map((sound, i) => {
      const r = Math.floor(i / cols);
      const inRow = Math.min(cols, n - r * cols);
      const x = (cols - inRow) / (2 * cols) + (i % cols) / cols;
      return { sound, shape: rect(x, r / used, 1 / cols, 1 / used) };
    }),
  );
}

// The spec's notes (MIDI, low to high), or why there are none.
function specNotes(spec: InstrumentSpec): number[] | string {
  if (!spec.noteRange) return "no note range";
  const lo = midi(spec.noteRange.low);
  const hi = midi(spec.noteRange.high);
  const [oLo, oHi] = CONFIG.layoutLimits.noteOctaves;
  if (lo === null || hi === null) return `note range ${rangeText(spec)} is not two notes like C4 in octaves ${oLo}-${oHi}`;
  if (lo > hi) return `note range ${rangeText(spec)} runs downward`;
  const root = spec.scale === "chromatic" ? 0 : pitchClass(spec.root);
  if (root === null) return `unknown scale root "${spec.root}"`;
  const steps: number[] = SCALES[spec.scale];
  const notes: number[] = [];
  for (let m = lo; m <= hi; m++) if (steps.includes((m - root + 12) % 12)) notes.push(m);
  return notes.length ? notes : `no ${spec.root} ${spec.scale} notes in ${rangeText(spec)}`;
}

const rangeText = (spec: InstrumentSpec) => (spec.noteRange ? `${spec.noteRange.low}–${spec.noteRange.high}` : "–");

// Freeform zones are passed on unchecked.
function build(spec: InstrumentSpec): { zones: unknown } | { problem: string } {
  if (spec.kind === "freeform") return { zones: spec.zones };
  if (spec.kind === "pads" && spec.sounds.length) return { zones: pads(spec.sounds, spec.rows) };
  const notes = specNotes(spec);
  if (typeof notes === "string") return { problem: notes };
  const { maxZones } = CONFIG.layoutLimits;
  if (notes.length > maxZones) return { problem: `${rangeText(spec)} is ${notes.length} notes; at most ${maxZones} fit` };
  const flats = spec.scale !== "chromatic" && /b$/.test(spec.root);
  if (spec.kind === "pads") return { zones: pads(notes.map((m) => note(m, flats)), spec.rows) };
  if (spec.scale !== "chromatic") return { zones: keys(notes, flats) };
  const naturals = notes.filter((m) => !isBlack(m));
  return { zones: spec.includeSharps ? piano(notes[0], notes[notes.length - 1]) : keys(naturals, false) };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

// Checks an untrusted spec's fields. An empty or missing noteRange is null.
export function checkSpec(v: unknown): InstrumentSpec | string {
  if (!isObj(v)) return "no spec";
  const kind = SPEC_KINDS.find((k) => k === v.kind);
  if (!kind) return `unknown kind "${String(v.kind)}"`;
  const scale = SCALE_NAMES.find((s) => s === v.scale) ?? "chromatic";
  const range = isObj(v.noteRange) ? { low: str(v.noteRange.low), high: str(v.noteRange.high) } : null;
  const sounds: Sound[] = [];
  for (const s of Array.isArray(v.sounds) ? v.sounds : []) {
    const sound = checkSound(s);
    if (typeof sound === "string") return `a sound ${sound}`;
    sounds.push(sound);
  }
  return {
    kind,
    instrument: str(v.instrument) || kind,
    noteRange: range?.low && range.high ? range : null,
    scale,
    root: str(v.root) || "C",
    includeSharps: v.includeSharps === true,
    rows: typeof v.rows === "number" && Number.isFinite(v.rows) ? v.rows : 1,
    sounds,
    notes: str(v.notes),
    zones: v.zones,
  };
}

// An untrusted spec to a checked Layout, or why it can't be used. warning: zones narrower
// than a finger (explicit requests are built anyway).
export function layoutFromSpec(
  v: unknown,
): { spec: InstrumentSpec; layout: Layout; warning: string | null } | { problem: string } {
  const spec = checkSpec(v);
  if (typeof spec === "string") return { problem: spec };
  const built = build(spec);
  if ("problem" in built) return built;
  const checked = checkLayout({ instrument: spec.instrument, zones: built.zones });
  return "problem" in checked ? checked : { spec, ...checked };
}

// e.g. "keyboard C4–B5, chromatic with sharps, 24 keys" or "pads 2×3, 6 sounds".
export function describeSpec(spec: InstrumentSpec, layout: Layout): string {
  const n = layout.zones.length;
  if (spec.kind === "freeform") return `freeform, ${n} zones placed by Muse Spark`;
  const scale =
    spec.scale === "chromatic" ? `chromatic${spec.includeSharps ? " with sharps" : ", naturals only"}` : `${spec.root} ${spec.scale}`;
  if (spec.kind === "keyboard") return `keyboard ${rangeText(spec)}, ${scale}, ${n} keys`;
  const what = spec.sounds.length ? `${spec.sounds.length} sounds` : `${rangeText(spec)} ${scale}`;
  const grid = gridSize(n, spec.rows);
  return `pads ${grid.rows}×${grid.cols}, ${what}`;
}

function preset(spec: Omit<InstrumentSpec, "notes" | "zones">): Layout {
  const built = layoutFromSpec({ ...spec, notes: "", zones: [] });
  if ("problem" in built) throw new Error(`preset ${spec.instrument}: ${built.problem}`);
  return built.layout;
}

// One octave, C4 to C5, with sharps.
export const PIANO_LAYOUT = preset({
  kind: "keyboard",
  instrument: "piano",
  noteRange: { low: "C4", high: "C5" },
  scale: "chromatic",
  root: "C",
  includeSharps: true,
  rows: 1,
  sounds: [],
});

// Like a kit from the drummer's seat: toms across the far side, high to low, and hi-hat,
// snare and kick nearest the player.
export const DRUM_LAYOUT = preset({
  kind: "pads",
  instrument: "drums",
  noteRange: null,
  scale: "chromatic",
  root: "C",
  includeSharps: false,
  rows: 2,
  sounds: ["tom1", "tom2", "tom3", "hihat", "snare", "kick"].map((sample) => ({ type: "drum", sample })),
});

export const PRESETS: Layout[] = [PIANO_LAYOUT, DRUM_LAYOUT];

// The preset closest to a free-text instrument request: drums for anything percussive,
// otherwise the piano (every pitched instrument plays through the piano sampler).
export function presetFor(request: string): Layout {
  return /\b(drum|kit|percussion|beat|snare|kick|hi-?hat|toms?\b|cymbal|cajon|bongo|conga|tabla)/i.test(request)
    ? DRUM_LAYOUT
    : PIANO_LAYOUT;
}
