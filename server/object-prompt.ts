// What Muse Spark is asked for each object pad: the instructions and the JSON schema of its
// answer (structured output, strict: one closed object, every key required). The browser
// checks the answer (checkDescription in src/objects.ts).
import { CONFIG } from "../src/config.ts";
import { DRUM_SAMPLES, OBJECT_VOICES } from "../src/layout.ts";

const SOUNDS = [...Object.keys(OBJECT_VOICES), ...DRUM_SAMPLES];
const PITCHED = Object.keys(OBJECT_VOICES).filter((v) => OBJECT_VOICES[v] !== null);

export const OBJECT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["isObject", "material", "name", "pitch", "sound"],
  properties: {
    isObject: {
      type: "boolean",
      description: "true if the highlighted region is a physical object on the desk (partly hidden counts)",
    },
    material: { type: "string", description: "its main material, one or two words, e.g. ceramic, glass, paper" },
    name: { type: "string", description: "what it is, 1-3 words, e.g. coffee mug, notebook, phone" },
    pitch: {
      type: "string",
      description: `for ${PITCHED.join("/")}: scientific pitch like C6; otherwise ""`,
    },
    sound: { type: "string", enum: SOUNDS },
  },
};

const [lo, hi] = CONFIG.layoutLimits.noteOctaves;

export const OBJECT_INSTRUCTIONS = `You turn objects on a desk into percussion pads. A webcam looks down at a desk;
an image segmenter found one region, and you see a crop around it with everything outside
the region dimmed. Tapping the object will play the sound you pick.

isObject: false only when the undimmed region is not a physical object on the desk: the desk
or tabletop itself, a person's hand or arm, a shadow or reflection, or a picture shown on a
screen. Objects partly hidden or cut off by something in front of them still count. Still
fill in the other fields with your best guess.

name: what it is in 1-3 plain words (coffee mug, notebook, phone, pencil, sticky note).
material: its main material in one or two words.

sound: pick by what the object is made of and how it would sound when tapped:
- bell: ceramic or porcelain (mugs, cups, bowls, plates)
- chime: glass (glasses, jars, bottles)
- metal: metal (cans, keys, tins, scissors, metal bottles)
- woodblock: wood (pencils, wooden boxes, rulers, coasters)
- pluck: hard plastic (pens, cases, toys, remotes)
- shaker: fabric or soft things (cloth, plush, sponge, crumpled paper)
- snare: paper and cardboard (notebooks, books, sticky notes, sheets, envelopes)
- hihat: electronics with a hard flat top (phones, mice, calculators)
- kick or tom1/tom2/tom3: large hollow or boxy things (laptops, speakers, boxes);
  tom1 is the highest tom, tom3 the lowest.

pitch: only for ${PITCHED.join(", ")}: a note like C6, octaves ${lo}-${hi}. Smaller objects ring higher,
larger ones lower (an espresso cup around C7, a big mug around G5). For any other sound, "".`;
