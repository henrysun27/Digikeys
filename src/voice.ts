// Push-to-talk for instrument requests: the mic is recorded in an AudioWorklet, resampled
// to CONFIG.voice.sampleRate mono, sent as a 16-bit WAV to the server and transcribed there
// by Muse Voice Transcribe.
import { CONFIG } from "./config.ts";
import { RAW_AUDIO } from "./mic.ts";
import type { RecorderMessage } from "./voice-worklet.ts";
import workletUrl from "./voice-worklet.ts?worker&url";

export type Speech = {
  wav: Blob;
  audioMs: number; // recorded length
  encodeMs: number; // resampling and WAV encoding
  encodeSyncMs: number; // the longest stretch of it on the main thread, including joining the chunks
  gain: number; // applied to reach CONFIG.voice.targetPeak
};

export type Transcript = {
  text: string;
  audioDurationMs: number | null; // as the model measured it
  sessionId: string | null;
  ms: number; // round trip as seen by the browser
  serverMs: number;
};

const modules = new WeakMap<AudioContext, Promise<void>>();

// One press of the talk button. Recording starts on construction; stop() ends it.
//
// With the tap mic on, it records a clone of that track: its own track, so nothing done to
// it reaches the tap mic's, and no second capture that could reconfigure the device. Without
// one, it opens a raw stream of its own. Either way the track is stopped with the recording.
export class Recording {
  private readonly ctx: AudioContext;
  private readonly ready: Promise<{ source: MediaStreamAudioSourceNode; node: AudioWorkletNode; track: MediaStreamTrack }>;
  private readonly chunks: Float32Array[] = [];

  constructor(ctx: AudioContext, tapTrack: MediaStreamTrack | null) {
    this.ctx = ctx;
    this.ready = this.open(tapTrack);
  }

  private async open(tapTrack: MediaStreamTrack | null) {
    const { ctx } = this;
    if (!modules.has(ctx)) modules.set(ctx, ctx.audioWorklet.addModule(workletUrl));
    const opened = tapTrack
      ? Promise.resolve(tapTrack.clone())
      : navigator.mediaDevices.getUserMedia({ audio: RAW_AUDIO, video: false }).then((s) => s.getAudioTracks()[0]);
    const [track] = await Promise.all([opened, modules.get(ctx), ctx.resume()]);
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const node = new AudioWorkletNode(ctx, "voice-recorder", { numberOfOutputs: 1 });
    node.port.onmessage = (e: MessageEvent<RecorderMessage>) => {
      if (e.data.type === "samples") this.chunks.push(e.data.samples);
    };
    source.connect(node);
    // The node writes silence; connecting it to the destination keeps it pulled.
    node.connect(ctx.destination);
    return { source, node, track };
  }

  // Ends the recording and encodes it, or null if it was too short to be meant.
  async stop(): Promise<Speech | null> {
    const { source, node, track } = await this.ready;
    await new Promise<void>((resolve) => {
      node.port.onmessage = (e: MessageEvent<RecorderMessage>) => {
        if (e.data.type === "samples") this.chunks.push(e.data.samples);
        else resolve();
      };
      node.port.postMessage("stop");
    });
    source.disconnect();
    node.disconnect();
    track.stop();

    const started = performance.now();
    const rate = this.ctx.sampleRate;
    const samples = new Float32Array(this.chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of this.chunks) {
      samples.set(c, at);
      at += c.length;
    }
    const joinMs = performance.now() - started;
    const audioMs = (samples.length / rate) * 1000;
    if (audioMs < CONFIG.voice.minMs) return null;
    const { wav, gain, syncMs } = await encodeWav(samples, rate);
    return { wav, audioMs, encodeMs: performance.now() - started, encodeSyncMs: Math.max(joinMs, syncMs), gain };
  }
}

// Resamples through an OfflineAudioContext (low-passed below the new Nyquist first), boosts
// quiet speech, and writes mono 16-bit PCM WAV.
async function encodeWav(samples: Float32Array<ArrayBuffer>, rate: number): Promise<{ wav: Blob; gain: number; syncMs: number }> {
  const { sampleRate: out, maxGain, targetPeak } = CONFIG.voice;
  const setupStart = performance.now();
  const offline = new OfflineAudioContext(1, Math.ceil((samples.length * out) / rate), out);
  const buffer = offline.createBuffer(1, samples.length, rate);
  buffer.copyToChannel(samples, 0);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  const lowpass = offline.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = out * 0.45;
  src.connect(lowpass).connect(offline.destination);
  src.start();
  const rendering = offline.startRendering();
  const setupMs = performance.now() - setupStart;
  const pcm = (await rendering).getChannelData(0);

  const writeStart = performance.now();
  const peak = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const gain = peak > 0 ? Math.min(maxGain, Math.max(1, targetPeak / peak)) : 1;
  const view = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const ascii = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, out, true);
  view.setUint32(28, out * 2, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  pcm.forEach((v, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, v * gain)) * 0x7fff), true));
  const wav = new Blob([view.buffer], { type: "audio/wav" });
  return { wav, gain, syncMs: Math.max(setupMs, performance.now() - writeStart) };
}

export async function transcribe(wav: Blob): Promise<Transcript> {
  const started = performance.now();
  const res = await fetch("/api/transcribe", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
  const body = await res.json().catch(() => ({ error: `server returned ${res.status}` }));
  if (!res.ok) throw new Error(body.error ?? `server returned ${res.status}`);
  return { ...body, ms: performance.now() - started, serverMs: body.ms };
}
