// What Muse Spark is asked for object pads: first the list of objects on the desk (whose
// names become SAM 3.1's text prompts), then, per segmented object, its name, material and
// sound. Both are structured output (strict: closed objects, every key required); the
// browser checks the answers (checkObjectList / checkDescription in src/objects.ts).
import { CONFIG } from "../src/config.ts";
import { DRUM_SAMPLES, OBJECT_VOICES } from "../src/layout.ts";

const SOUNDS = [...Object.keys(OBJECT_VOICES), ...DRUM_SAMPLES];
const PITCHED = Object.keys(OBJECT_VOICES).filter((v) => OBJECT_VOICES[v] !== null);

export const LIST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["objects"],
  properties: {
    objects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["count", "name"],
        properties: {
          count: { type: "integer", description: "how many of this kind are on the desk" },
          name: { type: "string", description: "a short common noun phrase, e.g. coffee mug, tablet, pencil" },
        },
      },
    },
  },
};

export const LIST_INSTRUCTIONS = `You list the physical objects on a desk, so each can become a percussion pad. A webcam
looks down at the desk; the paper the player uses as a keyboard is outlined in magenta.

List every distinct kind of object resting on the desk, each once with how many there are:
mugs, cups, glasses, bottles, phones, tablets, laptops, keyboards, mice, notebooks, books,
sticky notes, pens, pencils, boxes, toys, and so on. Flat objects count (a tablet, a phone, a
notebook, a sheet of paper that is not the outlined one); so do objects partly hidden by others
or cut off by the edge of the frame.

Leave out: the outlined paper itself, hands, arms and people, the desk surface, walls and
anything not on the desk, and what is shown on a screen (list the tablet, not the picture on
it). Never list a part of an object separately (the mug, not its handle).

Each name is the text prompt for an image segmenter, which finds every instance of a phrase:
use a short common noun phrase it would know ("tablet" rather than "iPad", "coffee mug",
"pencil"), add a color or material only to tell two different kinds apart ("red pen", "blue
pen"), and never list the same object under two names. At most ${CONFIG.objects.maxNames} kinds.`;

export const OBJECT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["material", "name", "pitch", "sound"],
  properties: {
    material: { type: "string", description: "its main material, one or two words, e.g. ceramic, glass, paper" },
    name: { type: "string", description: "what it is, 1-3 words, e.g. coffee mug, notebook, tablet" },
    pitch: {
      type: "string",
      description: `for ${PITCHED.join("/")}: scientific pitch like C6; otherwise ""`,
    },
    sound: { type: "string", enum: SOUNDS },
  },
};

const [lo, hi] = CONFIG.layoutLimits.noteOctaves;

export const OBJECT_INSTRUCTIONS = `You turn objects on a desk into percussion pads. A webcam looks down at a desk;
an image segmenter found one object, and you see a crop around it with everything outside
the object dimmed. Tapping the object will play the sound you pick.

name: what it is in 1-3 plain words (coffee mug, notebook, tablet, pencil, sticky note).
material: its main material in one or two words.

sound: pick by what the object is made of and how it would sound when tapped:
- bell: ceramic or porcelain (mugs, cups, bowls, plates)
- chime: glass (glasses, jars, bottles)
- metal: metal (cans, keys, tins, scissors, metal bottles)
- woodblock: wood (pencils, wooden boxes, rulers, coasters)
- pluck: hard plastic (pens, cases, toys, remotes)
- shaker: fabric or soft things (cloth, plush, sponge, crumpled paper)
- snare: paper and cardboard (notebooks, books, sticky notes, sheets, envelopes)
- hihat: electronics with a hard flat top (phones, tablets, mice, calculators)
- kick or tom1/tom2/tom3: large hollow or boxy things (laptops, speakers, boxes);
  tom1 is the highest tom, tom3 the lowest.

pitch: only for ${PITCHED.join(", ")}: a note like C6, octaves ${lo}-${hi}. Smaller objects ring higher,
larger ones lower (an espresso cup around C7, a big mug around G5). For any other sound, "".`;

// The describe request's text: what the segmenter was asked for when it found this object.
export const describeText = (prompt: string) =>
  `The segmenter found this object as "${prompt}". Describe it and pick its sound.`;
