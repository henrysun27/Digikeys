import { CONFIG } from "./config.ts";
import type { OnsetMessage } from "./onset-worklet.ts";
import workletUrl from "./onset-worklet.ts?worker&url";

export type Onset = { time: number; level: number; threshold: number }; // time: sound reached the mic, performance.now() ms
export type MicLevel = { level: number; floor: number; threshold: number };
export type MicInfo = {
  baseMs: number;
  outputMs: number;
  inputMs: number;
  inputSource: string;
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

// Must be called from a user gesture so the AudioContext may start.
export async function startMic(h: MicHandlers) {
  const ctx = new AudioContext({ latencyHint: "interactive" });
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

  const info = (): MicInfo => {
    const settings: AudioSettings = track.getSettings();
    const measured = track.stats?.latency;
    const [inputMs, inputSource] =
      measured !== undefined
        ? [measured * 1000, "track stats"]
        : settings.latency !== undefined
          ? [settings.latency * 1000, "track settings"]
          : [0, "not reported"];
    return {
      baseMs: ctx.baseLatency * 1000,
      outputMs: (ctx.outputLatency || 0) * 1000,
      inputMs,
      inputSource,
      ctxRate: ctx.sampleRate,
      micRate: settings.sampleRate ?? null,
    };
  };

  // getOutputTimestamp pairs a context time with the performance.now() moment it is heard.
  // A block is rendered baseLatency + outputLatency before it is heard, and the mic input
  // in it was captured inputLatency before it was rendered.
  const toPerf = (ctxTime: number, i: MicInfo): number => {
    const ts = ctx.getOutputTimestamp();
    const rendered =
      ts.performanceTime && ts.contextTime !== undefined
        ? ts.performanceTime + (ctxTime - ts.contextTime) * 1000 - i.baseMs - i.outputMs
        : performance.now() - (ctx.currentTime - ctxTime) * 1000; // output not running yet
    return rendered - i.inputMs;
  };

  h.onInfo(info());
  node.port.onmessage = (e: MessageEvent<OnsetMessage>) => {
    const msg = e.data;
    if (msg.type === "level") {
      h.onLevel(msg);
      return;
    }
    const i = info();
    h.onInfo(i);
    h.onOnset({ time: toPerf(msg.time, i), level: msg.level, threshold: msg.threshold });
  };
}
