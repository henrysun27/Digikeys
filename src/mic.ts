import { CONFIG } from "./config.ts";
import type { OnsetMessage } from "./onset-worklet.ts";
import workletUrl from "./onset-worklet.ts?worker&url";

export type Onset = {
  time: number; // performance.now() ms
  ctxTime: number; // the onset block's audio-clock time, s
  receivedAt: number; // performance.now() when the main thread got the onset message
  level: number;
  threshold: number;
};
export type MicLevel = { level: number; floor: number; threshold: number };
export type MicInfo = {
  outputRawMs: number; // baseLatency + outputLatency as reported
  outputMs: number; // the clamped correction actually applied
  clock: "output timestamp" | "currentTime";
  // Reported by the track for reference only; not used for correction.
  inputStatsRaw: number | null; // track.stats.latency (spec unit: ms)
  inputSettingsRaw: number | null; // getSettings().latency (spec unit: s)
  ctxRate: number;
  micRate: number | null;
};
export type MicHandlers = {
  onOnset: (o: Onset) => void;
  onLevel: (l: MicLevel) => void;
  onInfo: (i: MicInfo) => void;
};

// Not in the TS DOM lib yet; read defensively.
type AudioTrack = MediaStreamTrack & { stats?: { latency?: number } };
type AudioSettings = MediaTrackSettings & { latency?: number };

// baseLatency + outputLatency as reported, and clamped to 0..maxLatencyCorrectionMs for use.
export function outputLatency(ctx: AudioContext): { rawMs: number; ms: number } {
  const rawMs = ((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000;
  return { rawMs, ms: Math.min(CONFIG.mic.maxLatencyCorrectionMs, Math.max(0, rawMs)) };
}

// ctx must have been created in a user gesture so it may start.
export async function startMic(ctx: AudioContext, h: MicHandlers) {
  // Browser voice processing smears or removes tap transients.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    video: false,
  });
  const track: AudioTrack = stream.getAudioTracks()[0];
  await ctx.audioWorklet.addModule(workletUrl);
  await ctx.resume();

  const node = new AudioWorkletNode(ctx, "onset-detector", { processorOptions: CONFIG.onset });
  ctx.createMediaStreamSource(stream).connect(node);
  // The node writes silence; connecting it to the destination keeps it pulled.
  node.connect(ctx.destination);

  // Converts the worklet's audio-clock time for a block to performance.now() when it was
  // rendered. getOutputTimestamp pairs a context time with the moment it is heard, and a
  // block is rendered baseLatency + outputLatency before that. Input latency is taken as
  // 0; config.taps.videoLagMs absorbs any constant offset. Falls back to the currentTime
  // mapping if the output timestamp is missing or disagrees by more than the clamp.
  const toPerf = (ctxTime: number): { time: number; info: MicInfo } => {
    const settings: AudioSettings = track.getSettings();
    const { rawMs: outputRawMs, ms: outputMs } = outputLatency(ctx);
    const byCurrentTime = performance.now() - (ctx.currentTime - ctxTime) * 1000;
    const ts = ctx.getOutputTimestamp();
    const byOutput =
      ts.performanceTime && ts.contextTime !== undefined
        ? ts.performanceTime + (ctxTime - ts.contextTime) * 1000 - outputMs
        : null;
    const useOutput = byOutput !== null && Math.abs(byOutput - byCurrentTime) <= CONFIG.mic.maxLatencyCorrectionMs;
    return {
      time: useOutput ? byOutput : byCurrentTime,
      info: {
        outputRawMs,
        outputMs,
        clock: useOutput ? "output timestamp" : "currentTime",
        inputStatsRaw: track.stats?.latency ?? null,
        inputSettingsRaw: settings.latency ?? null,
        ctxRate: ctx.sampleRate,
        micRate: settings.sampleRate ?? null,
      },
    };
  };

  h.onInfo(toPerf(ctx.currentTime).info);
  // Onsets are handled before the debug-panel info: the sound can't wait, the panel can.
  node.port.onmessage = (e: MessageEvent<OnsetMessage>) => {
    const receivedAt = performance.now();
    const msg = e.data;
    if (msg.type === "level") {
      h.onLevel(msg);
      return;
    }
    const { time, info } = toPerf(msg.time);
    h.onOnset({ time, ctxTime: msg.time, receivedAt, level: msg.level, threshold: msg.threshold });
    h.onInfo(info);
  };
}
