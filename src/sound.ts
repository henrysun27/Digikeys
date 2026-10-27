import * as Tone from "tone";
import { CONFIG } from "./config.ts";
import { DRUM_SAMPLES, type Sound } from "./layout.ts";
import { outputLatency } from "./mic.ts";

// Salamander piano, sampled every minor third from C2 to C7; Sampler repitches in between.
const PIANO_SAMPLES: Record<string, string> = { C7: "C7.mp3" };
for (let octave = 2; octave <= 6; octave++) {
  for (const [note, file] of [["C", "C"], ["D#", "Ds"], ["F#", "Fs"], ["A", "A"]]) {
    PIANO_SAMPLES[`${note}${octave}`] = `${file}${octave}.mp3`;
  }
}

let audioCtx: AudioContext | null = null;
let master: Tone.Volume | null = null;
let piano: Tone.Sampler | null = null;
let drums: Tone.Players | null = null;

// Runs Tone on the same AudioContext as the mic detector so onsets and triggers share a
// clock. Lookahead is 0: taps must sound now, not on a schedule.
export async function initSound(ctx: AudioContext) {
  Tone.setContext(new Tone.Context({ context: ctx, latencyHint: "interactive", lookAhead: 0 }));
  const s = CONFIG.sound;
  master = new Tone.Volume(0).toDestination();
  piano = new Tone.Sampler({ urls: PIANO_SAMPLES, baseUrl: s.pianoBaseUrl, release: 1 }).connect(master);
  drums = new Tone.Players({
    urls: Object.fromEntries(DRUM_SAMPLES.map((d) => [d, `${d}.mp3`])),
    baseUrl: s.drumBaseUrl,
  }).connect(master);
  await Tone.loaded();

  // Warm up: play everything once, muted, so the first real tap doesn't pay for
  // first-use setup.
  master.mute = true;
  piano.triggerAttackRelease("C4", 0.05, Tone.now(), 0.01);
  for (const d of DRUM_SAMPLES) drums.player(d).start(Tone.now());
  audioCtx = ctx;
  await new Promise((r) => setTimeout(r, s.warmupMs));
  drums.stopAll();
  piano.releaseAll();
  master.mute = false;
}

// Plays the sound now (Tone.immediate: the context's currentTime, no lookahead offset).
// Returns the trigger's audio-clock time and the unclamped reported output latency, or
// null if nothing was played.
export function playNow(sound: Sound): { ctxTime: number; outputMs: number } | null {
  if (!audioCtx || !piano || !drums) return null;
  const t = Tone.immediate();
  if (sound.type === "note") {
    piano.triggerAttackRelease(sound.note, CONFIG.sound.noteSeconds, t, CONFIG.sound.velocity);
  } else if (drums.has(sound.sample)) {
    drums.player(sound.sample).start(t);
  } else {
    console.warn(`unknown drum sample "${sound.sample}"`);
    return null;
  }
  return { ctxTime: t, outputMs: outputLatency(audioCtx).rawMs };
}

// Plays the sound now. Returns tap-to-sound latency in ms (onset block's audio-clock time
// to the trigger time, plus the reported output latency), or null if nothing was played.
export function play(sound: Sound, onsetCtxTime: number): number | null {
  const p = playNow(sound);
  return p ? (p.ctxTime - onsetCtxTime) * 1000 + p.outputMs : null;
}
