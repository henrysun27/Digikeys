// Minimal API server: the only place that sees MODEL_API_KEY. Vite proxies /api here.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { decodeMaskToRaster, parseImageStream, recordsOfKind, type ResponsesEvent } from "@meta-sam/parser";
import { CONFIG } from "../src/config.ts";

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
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text();
    let message = text;
    try {
      message = JSON.parse(text).error?.message ?? text;
    } catch {
      // not JSON; keep the raw text
    }
    throw new HttpError(upstream.status, `${CONFIG.sam.model}: ${message}`);
  }

  const result = await parseImageStream(sseEvents(upstream.body)).finalResult;
  const objects = recordsOfKind(result.records, "mask").map((r) => ({
    id: r.objectId,
    confidence: r.confidence ?? null,
    bounds: r.bounds,
    mask: { width: r.mask.width, height: r.mask.height, bits: packBits(decodeMaskToRaster(r.mask)) },
  }));
  return { outcome: result.outcome.status, diagnostics: result.diagnostics.length, objects };
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
  if (!apiKey) console.warn("MODEL_API_KEY is not set; /api/segment will fail");
});
