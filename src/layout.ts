import { pointInPolygon, type Pt } from "./geometry.ts";

// Everything playable is a Zone in board coordinates (0-1 after the homography).
export type Shape =
  | { kind: "rect"; x: number; y: number; w: number; h: number }
  | { kind: "poly"; pts: [number, number][] };
export type Sound =
  | { type: "note"; note: string } // e.g. "C4"
  | { type: "drum"; sample: string }; // e.g. "snare"
export type Zone = { id: string; label: string; shape: Shape; sound: Sound };
export type Layout = { instrument: string; zones: Zone[] };

type Cell = Omit<Zone, "shape">;

// Equal-size rect zones, rows top to bottom.
function grid(instrument: string, rows: Cell[][]): Layout {
  const zones = rows.flatMap((row, r) =>
    row.map((cell, c): Zone => ({
      ...cell,
      shape: { kind: "rect", x: c / row.length, y: r / rows.length, w: 1 / row.length, h: 1 / rows.length },
    })),
  );
  return { instrument, zones };
}

const whiteKeys = (octave: number): Cell[] =>
  ["C", "D", "E", "F", "G", "A", "B"].map((name) => {
    const note = `${name}${octave}`;
    return { id: note, label: note, sound: { type: "note", note } };
  });

const pad = (sample: string, label: string): Cell => ({ id: sample, label, sound: { type: "drum", sample } });

// One row of 8 white keys, C4 to C5, each the full depth of the board: a single row
// leaves no front/back zone confusion.
export const PIANO_LAYOUT: Layout = grid("piano", [[...whiteKeys(4), whiteKeys(5)[0]]]);

export const DRUM_LAYOUT: Layout = grid("drums", [
  [pad("hihat", "Hi-hat"), pad("tom1", "Tom 1"), pad("tom2", "Tom 2")],
  [pad("kick", "Kick"), pad("snare", "Snare"), pad("tom3", "Tom 3")],
]);

export const PRESETS: Layout[] = [PIANO_LAYOUT, DRUM_LAYOUT];

export function shapeOutline(shape: Shape): Pt[] {
  if (shape.kind === "poly") return shape.pts.map(([x, y]) => ({ x, y }));
  const { x, y, w, h } = shape;
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

export function shapeCenter(shape: Shape): Pt {
  if (shape.kind === "rect") return { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 };
  const n = shape.pts.length;
  return {
    x: shape.pts.reduce((s, [x]) => s + x, 0) / n,
    y: shape.pts.reduce((s, [, y]) => s + y, 0) / n,
  };
}

function inShape(p: Pt, shape: Shape): boolean {
  if (shape.kind === "rect") {
    return p.x >= shape.x && p.x < shape.x + shape.w && p.y >= shape.y && p.y < shape.y + shape.h;
  }
  return pointInPolygon(p, shapeOutline(shape));
}

// p is in board coordinates.
export function hitTest(layout: Layout, p: Pt): Zone | null {
  return layout.zones.find((z) => inShape(p, z.shape)) ?? null;
}
