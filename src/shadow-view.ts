// The "Shadow check" view: each index fingertip's patch as sampled, enlarged, with what the
// shadow detection made of it, and the last calibration's gap distributions.
import { CONFIG } from "./config.ts";
import type { Pt } from "./geometry.ts";
import { PatchKind, type ShadowReading } from "./shadow.ts";
import type { CalibrationReport } from "./shadow-contact.ts";

// contrast: the finger's median contrast over its recent frames, for the warning.
export type CheckPatch = { finger: string; reading: ShadowReading; contrast: number };

const SCALE = 4; // screen pixels per patch cell
const GAP = 12;
const TEXT = 36;
const ROW = 30;

// Patches are drawn mirrored like the camera view, so left and right match what the player
// sees. Hand cells blue, the shadow red, other dark candidates orange, cells outside the
// search sector (or the frame) dimmed.
const TINTS: Record<number, string | null> = {
  [PatchKind.desk]: null,
  [PatchKind.hand]: "rgba(0, 140, 255, 0.35)",
  [PatchKind.shadow]: "rgba(255, 40, 80, 0.55)",
  [PatchKind.candidate]: "rgba(255, 170, 0, 0.3)",
  [PatchKind.outside]: "rgba(0, 0, 0, 0.55)",
};

function drawPatch(ctx: CanvasRenderingContext2D, x0: number, p: CheckPatch, dir: Pt | null) {
  const { patchCells: n, minShadowContrast, sectorDeg } = CONFIG.shadow;
  const view = p.reading.patch!;
  const mx = (x: number) => x0 + (n - x) * SCALE;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const v = view.gray[k];
      const x = mx(i + 1);
      ctx.fillStyle = `rgb(${v}, ${v}, ${v})`;
      ctx.fillRect(x, j * SCALE, SCALE, SCALE);
      const tint = TINTS[view.kind[k]];
      if (tint) {
        ctx.fillStyle = tint;
        ctx.fillRect(x, j * SCALE, SCALE, SCALE);
      }
    }
  }
  const c = { x: mx(n / 2), y: (n / 2) * SCALE };
  const size = n * SCALE;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, 0, size, size);
  ctx.clip();
  if (dir) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    for (const a of [-sectorDeg, sectorDeg]) {
      const r = (a * Math.PI) / 180;
      const d = { x: dir.x * Math.cos(r) - dir.y * Math.sin(r), y: dir.x * Math.sin(r) + dir.y * Math.cos(r) };
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(c.x - d.x * size, c.y + d.y * size);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  if (view.shadow) {
    const s = { x: mx(view.shadow.x), y: view.shadow.y * SCALE };
    ctx.strokeStyle = "#ffd400";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(s.x, s.y);
    ctx.stroke();
    ctx.fillStyle = "#ffd400";
    ctx.beginPath();
    ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#00e676";
  ctx.beginPath();
  ctx.arc(c.x, c.y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
  ctx.strokeRect(x0 + 0.5, 0.5, size - 1, size - 1);

  const r = p.reading;
  const weak = p.contrast < minShadowContrast;
  ctx.font = "600 12px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(`${p.finger} · gap ${r.gap === null ? "–" : r.gap.toFixed(2)}`, x0, size + 4);
  ctx.fillStyle = weak ? "#ff3b6b" : "#00e676";
  ctx.fillText(`contrast ${r.contrast.toFixed(2)} · median ${p.contrast.toFixed(2)}${weak ? " · weak" : ""}`, x0, size + 19);
}

// Rest steps green, lift steps orange, one row each, over a shared gap axis, with the
// threshold if there is one.
function drawReport(ctx: CanvasRenderingContext2D, y0: number, width: number, report: CalibrationReport) {
  const { histogramBins: bins } = CONFIG.shadow.calibration;
  const all = report.steps.flatMap((s) => s.gaps);
  const max = Math.max(0.5, ...all, report.threshold ?? 0) * 1.05;
  const label = 150;
  const plot = width - label;
  ctx.font = "12px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  report.steps.forEach((s, row) => {
    const y = y0 + row * ROW;
    const counts = new Array<number>(bins).fill(0);
    for (const g of s.gaps) counts[Math.min(bins - 1, Math.floor((g / max) * bins))]++;
    const top = Math.max(1, ...counts);
    ctx.fillStyle = s.label.startsWith("rest") ? "#00e676" : "#ffb300";
    counts.forEach((c, b) => {
      const h = (c / top) * (ROW - 6);
      ctx.fillRect(label + (b * plot) / bins + 1, y + ROW - 3 - h, plot / bins - 2, h);
    });
    const sorted = [...s.gaps].sort((a, b) => a - b);
    const med = sorted.length ? sorted[sorted.length >> 1].toFixed(2) : "–";
    const rejected = s.noShadow + s.weak;
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.fillText(`${s.label}: n ${s.gaps.length}, med ${med}`, 0, y + ROW / 2 - 6);
    ctx.fillStyle = "#aaaaaa";
    ctx.fillText(`rejected ${rejected} (${s.noShadow} none, ${s.weak} weak)`, 0, y + ROW / 2 + 7);
  });
  const axis = y0 + report.steps.length * ROW;
  ctx.fillStyle = "#aaaaaa";
  ctx.textAlign = "center";
  for (let v = 0; v <= max; v += 0.25) ctx.fillText(v.toFixed(2), label + (v / max) * plot, axis + 8);
  if (report.threshold !== null) {
    const x = label + (report.threshold / max) * plot;
    ctx.strokeStyle = "#ffffff";
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, axis);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// Redraws the view: up to two patches side by side, the report below them if given.
export function drawShadowCheck(
  canvas: HTMLCanvasElement,
  patches: CheckPatch[],
  dir: Pt | null,
  report: CalibrationReport | null,
) {
  const size = CONFIG.shadow.patchCells * SCALE;
  const width = 2 * size + GAP;
  const top = size + TEXT;
  const height = top + (report ? GAP + report.steps.length * ROW + 18 : 0);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, width, height);
  patches.slice(0, 2).forEach((p, i) => drawPatch(ctx, i * (size + GAP), p, dir));
  if (patches.length === 0) {
    ctx.fillStyle = "#aaaaaa";
    ctx.font = "13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Put an index fingertip over the board", width / 2, size / 2);
  }
  if (report) drawReport(ctx, top + GAP, width, report);
}
