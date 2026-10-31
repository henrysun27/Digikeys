// Play-mode presentation: the welcome screen, the Play/Debug switch, the setup stepper,
// toasts, the model chip and activity line, the control bar's status, warning banners, and
// sizing the stage. It holds no tap, audio or Meta
// API logic: its buttons click the Debug controls (or call what main.ts hands it), and
// their enabled/hidden state is mirrored back, so both views always agree.

export type Step = "surface" | "instrument" | "objects";
export type Model = "sam" | "spark" | "voice";
export type ToastKind = "info" | "success" | "error";

// The Debug controls Play mirrors, and the actions that aren't a single click.
export type UiControls = {
  detect: HTMLButtonElement;
  reset: HTMLButtonElement;
  accept: HTMLButtonElement;
  retry: HTMLButtonElement;
  discard: HTMLButtonElement;
  proposal: HTMLElement; // shown while SAM 3.1 surfaces wait for Accept or a choice
  hint: HTMLElement; // the corner-clicking hint
  surfacePrompt: HTMLInputElement; // empty: Muse Spark picks the surface; else SAM's prompt
  talk: HTMLButtonElement;
  generate: HTMLButtonElement;
  scan: HTMLButtonElement;
  clearObjects: HTMLButtonElement;
  mic: HTMLButtonElement;
  startTalk: () => void;
  stopTalk: () => void;
  build: (request: string) => void; // generate from free text
  chip: (name: string) => void;
};

const TOAST_MS = { info: 4000, success: 4000, error: 7000 };
const MODEL_NAMES: Record<Model, string> = { sam: "SAM 3.1", spark: "Muse Spark", voice: "Muse Voice Transcribe" };
const WELCOME_OUT_MS = 380;
const MAX_TOASTS = 2;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

let debug = false;
let onMode: () => void = () => {};
let surfaceDone = false;
let instrument: { name: string; detail: string } | null = null;
let objects: { count: number } | "skipped" | null = null;
let chosen: Step | null = null; // the step the player opened; null: the first not done
let expanded = false; // reopened with "Edit setup" after setup was complete
const busy = new Map<Model, number>();
const tasks = new Map<Model, string>(); // what each working model is doing, for the activity line
let busyOrder: Model[] = []; // most recently started last
let busySince = 0;
let busyTimer: number | null = null;
const dismissed = new Map<string, string>(); // banner id -> text dismissed
let fit: (() => void) | null = null;

export const isDebug = () => debug;

// "piano" -> "Piano", for names shown on their own.
export const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function setDebug(on: boolean) {
  debug = on;
  document.body.classList.toggle("debug", on);
  $("#mode-toggle").innerHTML = on ? "Play <kbd>D</kbd>" : "Debug <kbd>D</kbd>";
  fit?.();
  onMode();
}

// Copies `from`'s disabled state (and, if asked, its hidden state, text, or "on" class) to
// `to` whenever it changes.
function mirror(
  from: HTMLElement,
  to: HTMLElement,
  what: { hidden?: boolean; text?: boolean; on?: (on: boolean) => void } = {},
) {
  const copy = () => {
    if ("disabled" in from && "disabled" in to) (to as HTMLButtonElement).disabled = (from as HTMLButtonElement).disabled;
    if (what.hidden) to.hidden = from.hidden;
    if (what.text) to.textContent = from.textContent;
    what.on?.(from.classList.contains("on"));
  };
  new MutationObserver(copy).observe(from, { attributes: true, childList: true, characterData: true, subtree: true });
  copy();
}

export function initUi(c: UiControls, onModeChange: () => void) {
  onMode = onModeChange;

  // Play / Debug.
  $("#mode-toggle").addEventListener("click", () => setDebug(!debug));
  window.addEventListener("keydown", (e) => {
    const t = e.target;
    const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
    if (e.code === "KeyD" && !typing && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) setDebug(!debug);
  });

  // Step 1: surface.
  const pDetect = $<HTMLButtonElement>("#p-detect");
  const pAccept = $<HTMLButtonElement>("#p-accept");
  const pRetry = $<HTMLButtonElement>("#p-retry");
  pDetect.addEventListener("click", () => c.detect.click());
  pAccept.addEventListener("click", () => c.accept.click());
  pRetry.addEventListener("click", () => c.retry.click());
  $("#p-discard").addEventListener("click", () => c.discard.click());
  $("#p-reset").addEventListener("click", () => c.reset.click());
  mirror(c.detect, pDetect);
  mirror(c.accept, pAccept, { hidden: true });
  // The optional surface name, kept in step with the Debug prompt box both ways.
  const pSurface = $<HTMLInputElement>("#p-surface");
  pSurface.maxLength = c.surfacePrompt.maxLength;
  pSurface.addEventListener("input", () => (c.surfacePrompt.value = pSurface.value));
  c.surfacePrompt.addEventListener("input", () => (pSurface.value = c.surfacePrompt.value));
  pSurface.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !c.detect.disabled) c.detect.click();
  });
  mirror(c.retry, pRetry);
  mirror(c.proposal, $("#p-proposal"), { hidden: true });
  const hint = $("#surface-hint");
  new MutationObserver(() => {
    hint.textContent = c.hint.textContent;
    hint.classList.toggle("error", c.hint.classList.contains("error"));
  }).observe(c.hint, { attributes: true, childList: true, characterData: true, subtree: true });

  // Step 2: instrument. Hold to talk, like Space.
  const talk = $<HTMLButtonElement>("#p-talk");
  const talkLabel = talk.querySelector(".label")!;
  talk.addEventListener("pointerdown", (e) => {
    if (talk.disabled) return;
    talk.setPointerCapture(e.pointerId);
    c.startTalk();
  });
  talk.addEventListener("pointerup", c.stopTalk);
  talk.addEventListener("pointercancel", c.stopTalk);
  mirror(c.talk, talk, {
    on: (on) => {
      talk.classList.toggle("on", on);
      talkLabel.textContent = on ? "Listening… release to send" : "Hold to describe your instrument";
    },
  });
  const request = $<HTMLInputElement>("#p-request");
  const buildBtn = $<HTMLButtonElement>("#p-build button");
  $("#p-build").addEventListener("submit", (e) => {
    e.preventDefault();
    if (request.value.trim()) c.build(request.value.trim());
  });
  mirror(c.generate, buildBtn);
  for (const chip of document.querySelectorAll<HTMLButtonElement>("[data-chip]")) {
    chip.addEventListener("click", () => c.chip(chip.dataset.chip!));
    mirror(c.generate, chip);
  }

  // Step 3: objects.
  const pScan = $<HTMLButtonElement>("#p-scan");
  const pClear = $<HTMLButtonElement>("#p-clear-objects");
  pScan.addEventListener("click", () => c.scan.click());
  pClear.addEventListener("click", () => c.clearObjects.click());
  mirror(c.scan, pScan);
  new MutationObserver(() => (pClear.hidden = c.clearObjects.disabled)).observe(c.clearObjects, { attributes: true });
  $("#p-skip").addEventListener("click", () => {
    if (objects === null) objects = "skipped";
    chosen = null;
    expanded = false;
    render();
  });

  // Stepper navigation: done steps and the next one can be opened.
  for (const li of document.querySelectorAll<HTMLElement>("#stepper [data-step]")) {
    li.querySelector("button")!.addEventListener("click", () => {
      const step = li.dataset.step as Step;
      if (step !== "surface" && !surfaceDone) return;
      chosen = step;
      render();
    });
  }
  const edit = () => {
    expanded = true;
    chosen = "instrument";
    render();
  };
  $("#p-edit-bar").addEventListener("click", edit);

  // Control bar: the mic button is the Debug one's twin. Once audio is live it gives way to
  // the green "Mic on" status; while starting it shows a spinner.
  const pMic = $<HTMLButtonElement>("#p-mic");
  const bar = $("#controlbar");
  pMic.addEventListener("click", () => c.mic.click());
  mirror(c.mic, pMic, {
    text: true,
    on: () => {
      const text = c.mic.textContent ?? "";
      bar.classList.toggle("audio-live", c.mic.disabled && /^(Mic|Sound) on$/.test(text));
      pMic.classList.toggle("loading", c.mic.disabled && /…$/.test(text));
    },
  });

  // Welcome: Start opens the first unfinished step (step 1 before calibration).
  const welcome = $("#welcome");
  const start = $<HTMLButtonElement>("#start");
  start.addEventListener("click", () => {
    chosen = null;
    render();
    welcome.classList.add("leaving");
    setTimeout(() => {
      welcome.hidden = true;
      document.querySelector<HTMLElement>("#stepper [data-step].active button")?.focus({ preventScroll: true });
    }, WELCOME_OUT_MS);
  });
  if (!welcome.hidden) start.focus();

  setDebug(new URLSearchParams(location.search).has("debug"));
  render();
}

function render() {
  const done: Record<Step, boolean> = {
    surface: surfaceDone,
    instrument: instrument !== null,
    objects: objects !== null,
  };
  const order: Step[] = ["surface", "instrument", "objects"];
  const all = order.every((s) => done[s]);
  const collapsed = all && !expanded;
  const active = chosen ?? order.find((s) => !done[s]) ?? null;
  const stepper = $("#stepper");
  stepper.classList.toggle("collapsed", collapsed);
  $("#p-edit-bar").hidden = !collapsed;
  for (const li of stepper.querySelectorAll<HTMLElement>("[data-step]")) {
    const s = li.dataset.step as Step;
    li.classList.toggle("done", done[s]);
    li.classList.toggle("active", s === active);
    li.classList.toggle("locked", s !== "surface" && !surfaceDone);
  }
  stepper.querySelector('[data-step="surface"] .sub')!.textContent = surfaceDone ? "Ready" : "";
  stepper.querySelector('[data-step="instrument"] .sub')!.textContent = instrument?.name ?? "";
  stepper.querySelector('[data-step="objects"] .sub')!.textContent = objectsText() ?? "optional";
  for (const panel of stepper.querySelectorAll<HTMLElement>("[data-panel]")) {
    panel.hidden = collapsed || panel.dataset.panel !== active;
  }
  const pads = objects !== null && objects !== "skipped" && objects.count > 0 ? objectsText() : null;
  $("#p-instrument").textContent = instrument
    ? [instrument.name, instrument.detail, pads].filter(Boolean).join(" · ")
    : "";
  renderActivity();
}

// The activity line: the model working now, what it's doing and for how long, with a
// spinner and a sweeping bar. It sits in the open setup panel, else in the control bar, and
// the open step's number turns into a spinner.
const activity = (() => {
  const el = document.createElement("div");
  el.className = "activity";
  el.setAttribute("role", "status");
  el.innerHTML = '<span class="spinner" aria-hidden="true"></span><b class="who"></b><span class="what"></span><span class="time"></span><span class="sweep" aria-hidden="true"></span>';
  el.hidden = true;
  return el;
})();

function renderActivity() {
  const model = [...busyOrder].reverse().find((m) => (busy.get(m) ?? 0) > 0) ?? null;
  const stepper = $("#stepper");
  const panel = stepper.classList.contains("collapsed")
    ? null
    : stepper.querySelector<HTMLElement>("[data-panel]:not([hidden])");
  for (const li of stepper.querySelectorAll<HTMLElement>("[data-step]")) {
    li.classList.toggle("busy", model !== null && panel !== null && li.dataset.step === panel.dataset.panel);
  }
  if (model === null) {
    activity.hidden = true;
    return;
  }
  const home = panel ?? $("#toasts");
  if (activity.parentElement !== home) home.prepend(activity);
  activity.hidden = false;
  activity.querySelector(".who")!.textContent = MODEL_NAMES[model];
  activity.querySelector(".what")!.textContent = tasks.get(model) || "Working";
  activity.querySelector(".time")!.textContent = `${((performance.now() - busySince) / 1000).toFixed(1)} s`;
}

const objectsText = () =>
  objects === "skipped" ? "Skipped" : objects ? `${objects.count} object pad${objects.count === 1 ? "" : "s"}` : null;

// Several detected surfaces to choose from, as buttons in the surface step (each with its
// outline's color); an empty list removes them.
export function setSurfaceChoices(choices: { label: string; color: string }[], choose: (i: number) => void) {
  const box = $("#p-choices");
  box.hidden = choices.length === 0;
  box.replaceChildren(
    ...choices.map(({ label, color }, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "choice";
      b.style.setProperty("--choice", color);
      b.textContent = label;
      b.addEventListener("click", () => choose(i));
      return b;
    }),
  );
}

// Setup progress, from main.ts.
export function setSurfaceDone(on: boolean) {
  if (on === surfaceDone) return;
  surfaceDone = on;
  chosen = null;
  if (!on) expanded = true;
  render();
}

// A new instrument is in place (name, and e.g. "13 keys").
export function setInstrument(name: string, detail: string) {
  instrument = { name: title(name), detail };
  if (chosen === "instrument") chosen = null;
  if (objects !== null) expanded = false;
  render();
}

// Object pads from a scan (0 is a finished scan with none), or null when cleared.
export function setObjects(count: number | null) {
  objects = count === null ? null : { count };
  if (count !== null) {
    chosen = null;
    expanded = false;
  }
  render();
}

// Short feedback in the control bar; the newest MAX_TOASTS stay.
export function toast(text: string, kind: ToastKind = "info") {
  const box = $("#toasts");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = text;
  box.append(el);
  while (box.children.length > MAX_TOASTS) box.firstElementChild!.remove();
  setTimeout(() => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 300);
  }, TOAST_MS[kind]);
}

// Marks a model as working (calls nest), with what it's doing ("Building your
// instrument"): its name in the chip lights up and the activity line shows it with a timer.
export function working(model: Model, on: boolean, task = "") {
  const wasIdle = [...busy.values()].every((n) => n === 0);
  const n = Math.max(0, (busy.get(model) ?? 0) + (on ? 1 : -1));
  busy.set(model, n);
  if (on) {
    tasks.set(model, task);
    busyOrder = [...busyOrder.filter((m) => m !== model), model];
    if (wasIdle) busySince = performance.now();
  }
  document.querySelector(`#models [data-model="${model}"]`)!.classList.toggle("busy", n > 0);
  const anyBusy = [...busy.values()].some((k) => k > 0);
  if (anyBusy && busyTimer === null) busyTimer = window.setInterval(renderActivity, 100);
  if (!anyBusy && busyTimer !== null) {
    clearInterval(busyTimer);
    busyTimer = null;
  }
  renderActivity();
}

// The status corner: median tap-to-sound (null before any), mic state, hands in view.
export function setStatus(latencyMs: number | null, mic: string, hands: number) {
  $("#stat-latency").textContent = latencyMs === null ? "– ms" : `${latencyMs.toFixed(0)} ms`;
  const micEl = $("#stat-mic");
  micEl.textContent = mic;
  micEl.classList.toggle("on", mic === "Mic on");
  $("#stat-hands").textContent = `${hands} hand${hands === 1 ? "" : "s"}`;
}

// A dismissible warning above the stage, null to clear it. Once dismissed, the same text
// stays away; a different text for the same id shows again.
export function banner(id: string, text: string | null) {
  const box = $("#banners");
  let el = box.querySelector<HTMLElement>(`[data-banner="${id}"]`);
  if (text === null || dismissed.get(id) === text) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.className = "banner";
    el.dataset.banner = id;
    const span = document.createElement("span");
    const close = document.createElement("button");
    close.type = "button";
    close.className = "close";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "×";
    close.addEventListener("click", () => {
      dismissed.set(id, el!.querySelector("span")!.textContent ?? "");
      el!.remove();
    });
    el.append(span, close);
    box.append(el);
  }
  el.querySelector("span")!.textContent = text;
}

// Sizes the canvas to the largest box of its aspect inside the stage, now and whenever
// the stage resizes. Call again once the canvas has its camera size.
export function fitStage(canvas: HTMLCanvasElement) {
  if (fit) {
    fit();
    return;
  }
  const stage = $("#stage");
  fit = () => {
    if (!canvas.width || !canvas.height) return;
    const pad = debug ? 0 : 8;
    const w = Math.max(0, stage.clientWidth - 2 * pad);
    const h = Math.max(0, stage.clientHeight - 2 * pad);
    const k = Math.min(w / canvas.width, h / canvas.height);
    canvas.style.width = `${Math.floor(canvas.width * k)}px`;
    canvas.style.height = `${Math.floor(canvas.height * k)}px`;
  };
  new ResizeObserver(() => fit?.()).observe(stage);
  fit();
}
