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

function pianoRow(octave: number, y: number, h: number): Zone[] {
  const names = ["C", "D", "E", "F", "G", "A", "B"];
  return names.map((name, i) => {
    const note = `${name}${octave}`;
    return {
      id: note,
      label: note,
      shape: { kind: "rect", x: i / names.length, y, w: 1 / names.length, h },
      sound: { type: "note", note },
    };
  });
}

// 2x7 white keys: the higher octave on the top row.
export const PIANO_LAYOUT: Layout = {
  instrument: "piano",
  zones: [...pianoRow(5, 0, 0.5), ...pianoRow(4, 0.5, 0.5)],
};

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
