import { CONFIG } from "./config.ts";
import type { OnsetMessage } from "./onset-worklet.ts";
import workletUrl from "./onset-worklet.ts?worker&url";

export type Onset = { time: number; level: number; threshold: number }; // time: performance.now() ms
export type MicLevel = { level: number; floor: number; threshold: number };

// Must be called from a user gesture so the AudioContext may start.
export async function startMic(onOnset: (o: Onset) => void, onLevel: (l: MicLevel) => void) {
  const ctx = new AudioContext({ latencyHint: "interactive" });
  // Browser voice processing smears or removes tap transients.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    video: false,
  });
  await ctx.audioWorklet.addModule(workletUrl);
  await ctx.resume();

  const node = new AudioWorkletNode(ctx, "onset-detector", { processorOptions: CONFIG.onset });
  ctx.createMediaStreamSource(stream).connect(node);
  // The node writes silence; connecting it to the destination keeps it pulled.
  node.connect(ctx.destination);

  node.port.onmessage = (e: MessageEvent<OnsetMessage>) => {
    const msg = e.data;
    if (msg.type === "level") {
      onLevel(msg);
      return;
    }
    // Map audio-clock time to performance.now() so it lines up with finger samples.
    const time = performance.now() - (ctx.currentTime - msg.time) * 1000;
    onOnset({ time, level: msg.level, threshold: msg.threshold });
  };
}
