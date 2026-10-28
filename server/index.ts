// Minimal API server: the only place that sees MODEL_API_KEY. Vite proxies /api here.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { decodeMaskToRaster, parseImageStream, recordsOfKind, type ResponsesEvent } from "@meta-sam/parser";
import { CONFIG } from "../src/config.ts";
import { LAYOUT_INSTRUCTIONS, LAYOUT_SCHEMA, layoutRequestText, toZones, type Corner } from "./layout-prompt.ts";
import { EDGES, type Edge, type Orientation } from "../src/orientation.ts";

const apiKey = process.env.MODEL_API_KEY?.trim() || null;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > CONFIG.server.maxBodyBytes) throw new HttpError(413, "request body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
    message = JSON.parse(text).error?.message ?? text;
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

// Asks Muse Spark for the board's aspect and a Layout, as schema-constrained JSON. The
// layout is returned as the model gave it; the browser validates it.
async function generateLayout(
  image: string,
  request: string,
  width: number,
  height: number,
  corners: Corner[],
  orientation: Orientation,
) {
  const m = CONFIG.muse;
  const upstream = await fetch(`${CONFIG.server.apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: m.model,
      messages: [
        { role: "system", content: LAYOUT_INSTRUCTIONS },
        {
          role: "user",
          content: [
            { type: "text", text: layoutRequestText(request, width, height, corners, orientation) },
            { type: "image_url", image_url: { url: image } },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "desk_layout", strict: true, schema: LAYOUT_SCHEMA },
      },
      reasoning_effort: m.reasoningEffort,
      max_completion_tokens: m.maxCompletionTokens,
    }),
  });
  if (!upstream.ok) throw await upstreamError(upstream, m.model);
  const body = (await upstream.json()) as {
    choices?: { message?: { content?: string | null }; finish_reason?: string }[];
    usage?: unknown;
  };
  const choice = body.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new HttpError(502, `${m.model} ran out of tokens (max_completion_tokens ${m.maxCompletionTokens})`);
  }
  const content = choice?.message?.content;
  if (!content) throw new HttpError(502, `${m.model} returned no content (finish_reason ${choice?.finish_reason})`);
  let out: { aspectReasoning?: unknown; boardAspect?: unknown; instrument?: unknown; zones?: unknown };
  try {
    out = JSON.parse(content);
  } catch {
    throw new HttpError(502, `${m.model} returned invalid JSON`);
  }
  return {
    aspect: out.boardAspect,
    aspectReasoning: out.aspectReasoning,
    layout: { instrument: out.instrument, zones: toZones(out.zones) },
    usage: body.usage ?? null,
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
    const zones = Array.isArray(out.layout.zones) ? out.layout.zones.length : "no";
    console.log(`layout "${request}": ${zones} zone(s), aspect ${String(out.aspect)}, ${ms} ms`);
    send(res, 200, { ...out, model: CONFIG.muse.model, ms });
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
  if (!apiKey) console.warn("MODEL_API_KEY is not set; /api/segment and /api/layout will fail");
});
