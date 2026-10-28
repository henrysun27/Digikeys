import * as Tone from "tone";
import { CONFIG } from "./config.ts";
import { DRUM_SAMPLES, OBJECT_VOICES, type Sound } from "./layout.ts";
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
// Object pad voices (OBJECT_VOICES), synthesized: play(note, time). Polyphonic where a
// ring should survive the next tap.
type Voices = Record<string, (note: string, t: number) => void>;
let voices: Voices | null = null;

function makeVoices(out: Tone.ToneAudioNode): Voices {
  const v = CONFIG.sound.velocity;
  const bell = new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 3.01,
    modulationIndex: 12,
    envelope: { attack: 0.001, decay: 1.6, sustain: 0, release: 1.6 },
    modulationEnvelope: { attack: 0.001, decay: 0.5, sustain: 0, release: 0.5 },
  }).connect(out);
  const chime = new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 5.1,
    modulationIndex: 3,
    envelope: { attack: 0.001, decay: 2.2, sustain: 0, release: 2.2 },
    modulationEnvelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.2 },
  }).connect(out);
  const woodblock = new Tone.PolySynth(Tone.MembraneSynth, {
    pitchDecay: 0.006,
    octaves: 1.5,
    oscillator: { type: "sine" },
    envelope: { attack: 0.001, decay: 0.09, sustain: 0, release: 0.05 },
  }).connect(out);
  const pluck = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "triangle" },
    envelope: { attack: 0.002, decay: 0.25, sustain: 0, release: 0.15 },
  }).connect(out);
  const metal = new Tone.MetalSynth({
    harmonicity: 5.1,
    modulationIndex: 24,
    resonance: 3000,
    octaves: 1.2,
    envelope: { attack: 0.001, decay: 0.5, release: 0.3 },
  }).connect(out);
  metal.volume.value = -12;
  const shakerFilter = new Tone.Filter(5000, "highpass").connect(out);
  const shaker = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.002, decay: 0.07, sustain: 0, release: 0.03 },
  }).connect(shakerFilter);
  return {
    bell: (n, t) => bell.triggerAttackRelease(n, 1.6, t, v),
    chime: (n, t) => chime.triggerAttackRelease(n, 2.2, t, v),
    woodblock: (n, t) => woodblock.triggerAttackRelease(n, 0.1, t, v),
    pluck: (n, t) => pluck.triggerAttackRelease(n, 0.25, t, v),
    metal: (_, t) => metal.triggerAttackRelease("C4", 0.3, t, v),
    shaker: (_, t) => shaker.triggerAttackRelease(0.08, t, v),
  };
}

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
  const objectVoices = makeVoices(master);
  await Tone.loaded();

  // Warm up: play everything once, muted, so the first real tap doesn't pay for
  // first-use setup.
  master.mute = true;
  piano.triggerAttackRelease("C4", 0.05, Tone.now(), 0.01);
  for (const d of DRUM_SAMPLES) drums.player(d).start(Tone.now());
  for (const [name, note] of Object.entries(OBJECT_VOICES)) objectVoices[name](note ?? "C5", Tone.now());
  voices = objectVoices;
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
  if (!audioCtx || !piano || !drums || !voices) return null;
  const t = Tone.immediate();
  if (sound.type === "note") {
    piano.triggerAttackRelease(sound.note, CONFIG.sound.noteSeconds, t, CONFIG.sound.velocity);
  } else if (sound.type === "voice") {
    const play = voices[sound.voice];
    if (!play) {
      console.warn(`unknown voice "${sound.voice}"`);
      return null;
    }
    play(sound.note, t);
  } else if (drums.has(sound.sample)) {
    drums.player(sound.sample).start(t);
  } else {
    console.warn(`unknown drum sample "${sound.sample}"`);
    return null;
  }
  return { ctxTime: t, outputMs: outputLatency(audioCtx).rawMs };
}
