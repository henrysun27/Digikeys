// Minimal API server: the only place that sees MODEL_API_KEY. Vite proxies /api here.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { decodeMaskToRaster, parseImageStream, recordsOfKind, type ResponsesEvent } from "@meta-sam/parser";
import { CONFIG } from "../src/config.ts";
import { LAYOUT_INSTRUCTIONS, LAYOUT_SCHEMA, layoutRequestText, toZones, type Corner } from "./layout-prompt.ts";
import { EDGES, type Edge, type Orientation } from "../src/orientation.ts";
import { describeText, LIST_INSTRUCTIONS, LIST_SCHEMA, OBJECT_INSTRUCTIONS, OBJECT_SCHEMA } from "./object-prompt.ts";
import { SURFACE_INSTRUCTIONS, SURFACE_SCHEMA } from "./surface-prompt.ts";

const apiKey = process.env.MODEL_API_KEY?.trim() || null;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req, CONFIG.server.maxBodyBytes);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "body is not JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// Server-sent events from the Responses API, as the parser's event objects.
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ResponsesEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      yield JSON.parse(data) as ResponsesEvent;
    }
  }
}

async function upstreamError(upstream: Response, model: string): Promise<HttpError> {
  const text = await upstream.text();
  let message = text;
  try {
    const parsed = JSON.parse(text);
    message = parsed.error?.message ?? parsed.message ?? text;
  } catch {
    // not JSON; keep the raw text
  }
  return new HttpError(upstream.status, `${model}: ${message}`);
}

// One bit per pixel, row-major, most significant bit first.
function packBits(raster: Uint8Array): string {
  const packed = new Uint8Array(Math.ceil(raster.length / 8));
  raster.forEach((v, i) => {
    if (v) packed[i >> 3] |= 0x80 >> (i & 7);
  });
  return Buffer.from(packed).toString("base64");
}

async function segment(image: string, prompt: string) {
  const upstream = await fetch(`${CONFIG.server.apiBaseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: CONFIG.sam.model,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: image },
          ],
        },
      ],
      stream: true,
      metadata: { mask_encoding: "one_bit", include_confidence: "true" },
    }),
  });
  if (!upstream.ok || !upstream.body) throw await upstreamError(upstream, CONFIG.sam.model);

  const result = await parseImageStream(sseEvents(upstream.body)).finalResult;
  const objects = recordsOfKind(result.records, "mask").map((r) => ({
    id: r.objectId,
    confidence: r.confidence ?? null,
    bounds: r.bounds,
    mask: { width: r.mask.width, height: r.mask.height, bits: packBits(decodeMaskToRaster(r.mask)) },
  }));
  return { outcome: result.outcome.status, diagnostics: result.diagnostics.length, objects };
}

// One Muse Spark Chat Completions call with an image and schema-constrained JSON output:
// the parsed JSON object and the usage.
async function museJson(
  instructions: string,
  text: string,
  image: string,
  schema: { name: string; schema: unknown },
  maxCompletionTokens: number,
): Promise<{ out: Record<string, unknown>; usage: unknown }> {
  const m = CONFIG.muse;
  const upstream = await fetch(`${CONFIG.server.apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: m.model,
      messages: [
        { role: "system", content: instructions },
        {
          role: "user",
          content: [
            { type: "text", text },
            { type: "image_url", image_url: { url: image } },
          ],
        },
      ],
      response_format: { type: "json_schema", json_schema: { ...schema, strict: true } },
      reasoning_effort: m.reasoningEffort,
      max_completion_tokens: maxCompletionTokens,
    }),
  });
  if (!upstream.ok) throw await upstreamError(upstream, m.model);
  const body = (await upstream.json()) as {
    choices?: { message?: { content?: string | null }; finish_reason?: string }[];
    usage?: unknown;
  };
  const choice = body.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new HttpError(502, `${m.model} ran out of tokens (max_completion_tokens ${maxCompletionTokens})`);
  }
  const content = choice?.message?.content;
  if (!content) throw new HttpError(502, `${m.model} returned no content (finish_reason ${choice?.finish_reason})`);
  let out: unknown;
  try {
    out = JSON.parse(content);
  } catch {
    throw new HttpError(502, `${m.model} returned invalid JSON`);
  }
  if (typeof out !== "object" || out === null) throw new HttpError(502, `${m.model} returned no JSON object`);
  return { out: out as Record<string, unknown>, usage: body.usage ?? null };
}

// Asks Muse Spark for the board's aspect and an InstrumentSpec, as schema-constrained JSON.
// The spec is returned as the model gave it (freeform zones in Layout form); the browser
// validates it and builds the layout.
async function generateLayout(
  image: string,
  request: string,
  width: number,
  height: number,
  corners: Corner[],
  orientation: Orientation,
) {
  const { out, usage } = await museJson(
    LAYOUT_INSTRUCTIONS,
    layoutRequestText(request, width, height, corners, orientation),
    image,
    { name: "instrument_spec", schema: LAYOUT_SCHEMA },
    CONFIG.muse.maxCompletionTokens,
  );
  const { boardAspect, ...spec } = out;
  return { aspect: boardAspect, spec: { ...spec, zones: toZones(out.zones) }, usage };
}

// Object pads, step 1: Muse Spark lists the kinds of objects on the desk (the board
// outlined in the image), as {objects: [{name, count}]}, unchecked.
async function listObjects(image: string) {
  const { out, usage } = await museJson(
    LIST_INSTRUCTIONS,
    "List the objects on this desk.",
    image,
    { name: "desk_objects", schema: LIST_SCHEMA },
    CONFIG.objects.listMaxCompletionTokens,
  );
  return { list: out, usage };
}

// Detect surface with no prompt: Muse Spark names the flat surfaces in view, best first, as
// {surfaces: [{name, reason}]}, unchecked. The browser then segments each name through
// /api/objects/segment.
async function listSurfaces(image: string) {
  const { out, usage } = await museJson(
    SURFACE_INSTRUCTIONS,
    "List the flat surfaces in view that could be the playing area, best first.",
    image,
    { name: "playing_surfaces", schema: SURFACE_SCHEMA },
    CONFIG.sam.autoSurface.listMaxCompletionTokens,
  );
  return { list: out, usage };
}

// Step 2: SAM 3.1 has no prompt-free mode, so each listed name runs as a text prompt, all in
// parallel. Matches come back tagged with their name; the browser merges them. A name that
// fails is reported, unless all do.
async function segmentObjects(image: string, prompts: string[]) {
  const runs = await Promise.allSettled(prompts.map((p) => segment(image, p)));
  const objects = runs.flatMap((r, i) =>
    r.status === "fulfilled" ? r.value.objects.map((o) => ({ ...o, prompt: prompts[i] })) : [],
  );
  const failed = runs.flatMap((r, i) =>
    r.status === "rejected"
      ? [{ prompt: prompts[i], error: r.reason instanceof Error ? r.reason.message : String(r.reason) }]
      : [],
  );
  if (failed.length === runs.length) throw new HttpError(502, `every name failed: ${failed[0].error}`);
  return { objects, failed };
}

// Step 3: Muse Spark names one object's crop, its material and a sound (unchecked; the
// browser checks). prompt: the name SAM found it under.
async function describeObject(image: string, prompt: string) {
  const { out, usage } = await museJson(
    OBJECT_INSTRUCTIONS,
    describeText(prompt),
    image,
    { name: "object_pad", schema: OBJECT_SCHEMA },
    CONFIG.objects.maxCompletionTokens,
  );
  return { description: out, usage };
}

// Muse Voice Transcribe, one buffered request per push-to-talk clip (PUSH_TO_TALK mode: the
// clip is one turn). The settings go as a JSON part next to the WAV.
async function transcribe(wav: Buffer) {
  const v = CONFIG.voice;
  const settings = { model: v.model, audioEncoding: "WAV", mode: "PUSH_TO_TALK", keywords: v.keywords };
  const form = new FormData();
  form.append("request", new Blob([JSON.stringify(settings)], { type: "application/json" }));
  form.append("audio", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
  const upstream = await fetch(`${CONFIG.server.apiBaseUrl}/asr/transcribe`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    body: form,
  });
  if (!upstream.ok) throw await upstreamError(upstream, v.model);
  const body = (await upstream.json()) as { transcript?: unknown; audioDurationMs?: unknown; sessionId?: unknown };
  return {
    text: typeof body.transcript === "string" ? body.transcript.trim() : "",
    audioDurationMs: typeof body.audioDurationMs === "number" ? body.audioDurationMs : null,
    sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
  };
}

const isCorner = (c: unknown): c is Corner =>
  typeof c === "object" && c !== null && Number.isFinite((c as Corner).x) && Number.isFinite((c as Corner).y);

// The left edge must be next to the near edge: not the same edge, not the opposite one.
function isOrientation(o: unknown): o is Orientation {
  if (typeof o !== "object" || o === null) return false;
  const { near, left } = o as Record<string, unknown>;
  const i = EDGES.indexOf(near as Edge);
  const j = EDGES.indexOf(left as Edge);
  return i >= 0 && j >= 0 && (i - j + 4) % 2 === 1;
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (req.method === "GET" && path === "/api/health") {
    send(res, 200, { ok: true, apiKey: apiKey !== null });
    return;
  }
  if (req.method === "POST" && path === "/api/segment") {
    if (!apiKey) throw new HttpError(500, "MODEL_API_KEY is not set in .env");
    const body = (await readJson(req)) as { image?: unknown; prompt?: unknown };
    const { image, prompt } = body ?? {};
    if (typeof image !== "string" || !image.startsWith("data:image/")) {
      throw new HttpError(400, "image must be an image data URL");
    }
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > CONFIG.server.maxPromptChars) {
      throw new HttpError(400, `prompt must be 1-${CONFIG.server.maxPromptChars} characters`);
    }
    const started = performance.now();
    const out = await segment(image, prompt.trim());
    const ms = Math.round(performance.now() - started);
    console.log(`segment "${prompt}": ${out.objects.length} object(s), ${out.outcome}, ${ms} ms`);
    send(res, 200, { ...out, ms });
    return;
  }
  if (req.method === "POST" && path === "/api/surfaces/list") {
    if (!apiKey) throw new HttpError(500, "MODEL_API_KEY is not set in .env");
    const body = (await readJson(req)) as { image?: unknown };
    if (typeof body?.image !== "string" || !body.image.startsWith("data:image/")) {
      throw new HttpError(400, "image must be an image data URL");
    }
    const started = performance.now();
    const out = await listSurfaces(body.image);
    const ms = Math.round(performance.now() - started);
    console.log(`surface list: ${JSON.stringify(out.list)}, ${ms} ms`);
    send(res, 200, { ...out, model: CONFIG.muse.model, ms });
    return;
  }
  if (req.method === "POST" && path.startsWith("/api/objects/")) {
    if (!apiKey) throw new HttpError(500, "MODEL_API_KEY is not set in .env");
    const body = (await readJson(req)) as { image?: unknown; prompts?: unknown; prompt?: unknown };
    const { image, prompts, prompt } = body ?? {};
    if (typeof image !== "string" || !image.startsWith("data:image/")) {
      throw new HttpError(400, "image must be an image data URL");
    }
    const { maxPromptChars } = CONFIG.server;
    const isPrompt = (p: unknown): p is string => typeof p === "string" && p.trim() !== "" && p.length <= maxPromptChars;
    const started = performance.now();
    if (path === "/api/objects/list") {
      const out = await listObjects(image);
      const ms = Math.round(performance.now() - started);
      console.log(`object list: ${JSON.stringify(out.list)}, ${ms} ms`);
      send(res, 200, { ...out, model: CONFIG.muse.model, ms });
    } else if (path === "/api/objects/segment") {
      const max = CONFIG.objects.maxNames;
      if (!Array.isArray(prompts) || prompts.length < 1 || prompts.length > max || !prompts.every(isPrompt)) {
        throw new HttpError(400, `prompts must be 1-${max} names of 1-${maxPromptChars} characters`);
      }
      const out = await segmentObjects(image, prompts.map((p) => p.trim()));
      const ms = Math.round(performance.now() - started);
      const failed = out.failed.map((f) => `; "${f.prompt}" failed: ${f.error}`).join("");
      console.log(`objects: ${out.objects.length} match(es) from ${prompts.length} names, ${ms} ms${failed}`);
      send(res, 200, { ...out, ms });
    } else if (path === "/api/objects/describe") {
      if (!isPrompt(prompt)) throw new HttpError(400, `prompt must be 1-${maxPromptChars} characters`);
      const out = await describeObject(image, prompt.trim());
      const ms = Math.round(performance.now() - started);
      console.log(`object "${prompt}": ${JSON.stringify(out.description)}, ${ms} ms`);
      send(res, 200, { ...out, model: CONFIG.muse.model, ms });
    } else throw new HttpError(404, `no route for ${req.method} ${path}`);
    return;
  }
  if (req.method === "POST" && path === "/api/layout") {
    if (!apiKey) throw new HttpError(500, "MODEL_API_KEY is not set in .env");
    const body = (await readJson(req)) as {
      image?: unknown;
      request?: unknown;
      width?: unknown;
      height?: unknown;
      corners?: unknown;
      orientation?: unknown;
    };
    const { image, request, width, height, corners, orientation } = body ?? {};
    if (typeof image !== "string" || !image.startsWith("data:image/")) {
      throw new HttpError(400, "image must be an image data URL");
    }
    if (typeof request !== "string" || !request.trim() || request.length > CONFIG.server.maxPromptChars) {
      throw new HttpError(400, `request must be 1-${CONFIG.server.maxPromptChars} characters`);
    }
    if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) {
      throw new HttpError(400, "width and height must be the image size");
    }
    if (!Array.isArray(corners) || corners.length !== 4 || !corners.every(isCorner)) {
      throw new HttpError(400, "corners must be 4 {x, y} pixel positions");
    }
    if (!isOrientation(orientation)) {
      throw new HttpError(400, `orientation must be {near, left}, adjacent edges of ${EDGES.join(", ")}`);
    }
    const started = performance.now();
    const out = await generateLayout(image, request.trim(), width, height, corners, orientation);
    const ms = Math.round(performance.now() - started);
    const { zones: _, ...brief } = out.spec;
    console.log(`layout "${request}": ${ms} ms, aspect ${String(out.aspect)}, ${JSON.stringify(brief)}`);
    console.log(`  usage ${JSON.stringify(out.usage)}`);
    send(res, 200, { ...out, model: CONFIG.muse.model, ms });
    return;
  }
  if (req.method === "POST" && path === "/api/transcribe") {
    if (!apiKey) throw new HttpError(500, "MODEL_API_KEY is not set in .env");
    const wav = await readBody(req, CONFIG.voice.maxWavBytes);
    if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
      throw new HttpError(400, "body must be a WAV file");
    }
    const started = performance.now();
    const out = await transcribe(wav);
    const ms = Math.round(performance.now() - started);
    console.log(`transcribe ${wav.length} bytes: "${out.text}", ${ms} ms (session ${out.sessionId})`);
    send(res, 200, { ...out, ms });
    return;
  }
  throw new HttpError(404, `no route for ${req.method} ${path}`);
}

createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${req.method} ${req.url} -> ${status}: ${message}`);
    if (!res.headersSent) send(res, status, { error: message });
    else res.end();
  });
}).listen(CONFIG.server.port, "127.0.0.1", () => {
  console.log(`api server on http://127.0.0.1:${CONFIG.server.port}`);
  if (!apiKey) console.warn("MODEL_API_KEY is not set; the model routes under /api will fail");
});
