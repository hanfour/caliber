import { request } from "undici";
import type { ResolvedCredential } from "./resolveCredential.js";

const ANTHROPIC_VERSION = "2023-06-01";
const OAUTH_BETA = "oauth-2025-04-20";

export interface UpstreamCallInput {
  baseUrl: string;
  body: Buffer | string;
  credential: ResolvedCredential;
  signal?: AbortSignal;
  forwardHeaders?: Record<string, string>;
  timeoutMs?: number;
}

export interface NonStreamUpstreamResult {
  kind: "non-stream";
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface StreamUpstreamResult {
  kind: "stream";
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Buffer>;
}

export type UpstreamResult = NonStreamUpstreamResult | StreamUpstreamResult;

function buildAuthHeaders(
  credential: ResolvedCredential,
): Record<string, string> {
  if (credential.type === "api_key") {
    return {
      "x-api-key": credential.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    };
  }
  return {
    authorization: `Bearer ${credential.accessToken}`,
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": OAUTH_BETA,
  };
}

/**
 * Inspect a request body buffer/string for `{ stream: true }`.  Both
 * the Anthropic and OpenAI upstream helpers use this to decide whether
 * to ask for SSE on the upstream call. Exported so `upstreamCallOpenai`
 * shares a single implementation.
 */
export function isStreamRequest(body: Buffer | string): boolean {
  try {
    const text = typeof body === "string" ? body : body.toString("utf8");
    const parsed = JSON.parse(text);
    return parsed?.stream === true;
  } catch {
    return false;
  }
}

export async function callUpstreamMessages(
  input: UpstreamCallInput,
): Promise<UpstreamResult> {
  const url = new URL("/v1/messages", input.baseUrl).toString();

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    ...input.forwardHeaders,
    ...buildAuthHeaders(input.credential),
  };

  // Strip hop-by-hop / forbidden headers that should never be forwarded.
  delete headers["host"];
  delete headers["content-length"];
  delete headers["connection"];

  const stream = isStreamRequest(input.body);
  if (stream) {
    headers["accept"] = "text/event-stream";
  }

  const timeout = input.timeoutMs ?? 60_000;

  const res = await request(url, {
    method: "POST",
    headers,
    body: input.body,
    signal: input.signal,
    bodyTimeout: timeout,
    headersTimeout: timeout,
  });

  if (stream) {
    return {
      kind: "stream",
      status: res.statusCode,
      headers: res.headers as Record<string, string | string[] | undefined>,
      body: res.body as unknown as AsyncIterable<Buffer>,
    };
  }

  const chunks: Buffer[] = [];
  for await (const chunk of res.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return {
    kind: "non-stream",
    status: res.statusCode,
    headers: res.headers as Record<string, string | string[] | undefined>,
    body: Buffer.concat(chunks),
  };
}
