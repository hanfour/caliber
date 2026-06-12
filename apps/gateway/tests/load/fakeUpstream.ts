import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeUpstream {
  baseUrl: string;
  /** Force an HTTP status for requests carrying this credential token. */
  forceStatus(token: string, status: number): void;
  /** Per-response latency in ms (applies to all routes). */
  setLatency(ms: number): void;
  /** First-token delay for SSE streams (ms). */
  setFirstTokenDelay(ms: number): void;
  requestCount(): number;
  errorCount(): number;
  /** Clear counters, forced statuses, and latency. */
  reset(): void;
  stop(): Promise<void>;
}

/** The credential token a request carried (api_key → x-api-key, oauth → Bearer). */
function credentialTokenOf(headers: NodeJS.Dict<string | string[]>): string {
  const xKey = headers["x-api-key"];
  if (typeof xKey === "string" && xKey.length > 0) return xKey;
  const auth = headers["authorization"];
  return typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
}

function anthropicBody(model: string): string {
  return JSON.stringify({
    id: "msg_fake", type: "message", role: "assistant", model,
    content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 2 },
  });
}

function openaiResponsesBody(model: string): string {
  return JSON.stringify({
    id: "resp_fake", object: "response", model, status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  });
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function startFakeUpstream(): Promise<FakeUpstream> {
  let latency = 0;
  let firstTokenDelay = 0;
  let requests = 0;
  let errors = 0;
  const forced = new Map<string, number>();

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", async () => {
      requests += 1;
      let parsed: { model?: string; stream?: boolean } = {};
      try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* keep {} */ }
      const model = typeof parsed.model === "string" ? parsed.model : "unknown";
      const token = credentialTokenOf(req.headers);
      const url = req.url ?? "";
      const isOpenai = url.startsWith("/v1/responses");

      if (latency > 0) await wait(latency);

      const status = forced.get(token);
      if (status !== undefined && status >= 300) {
        errors += 1;
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ type: "error", error: { type: "forced", message: `forced ${status}` } }));
        return;
      }

      if (parsed.stream === true) {
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        if (firstTokenDelay > 0) await wait(firstTokenDelay);
        if (isOpenai) {
          res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_fake", model } })}\n\n`);
          res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`);
          res.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_fake", model, usage: { input_tokens: 3, output_tokens: 2 } } })}\n\n`);
        } else {
          res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_fake", model, usage: { input_tokens: 3, output_tokens: 0 } } })}\n\n`);
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n`);
          res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 2 } })}\n\n`);
          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
        }
        res.end();
        return;
      }

      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(isOpenai ? openaiResponsesBody(model) : anthropicBody(model));
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    baseUrl,
    forceStatus: (t, s) => { forced.set(t, s); },
    setLatency: (ms) => { latency = ms; },
    setFirstTokenDelay: (ms) => { firstTokenDelay = ms; },
    requestCount: () => requests,
    errorCount: () => errors,
    reset: () => { requests = 0; errors = 0; forced.clear(); latency = 0; firstTokenDelay = 0; },
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}
