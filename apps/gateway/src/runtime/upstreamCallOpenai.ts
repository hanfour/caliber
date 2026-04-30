// Plan 5A PR 9d — OpenAI Responses API upstream HTTP client.
//
// Mirrors `callUpstreamMessages` (which targets Anthropic's
// `/v1/messages`) but hits OpenAI's `/v1/responses` and uses
// OpenAI's auth conventions:
//   * api_key credentials (sk-...)            → `Authorization: Bearer <key>`
//   * oauth credentials (ChatGPT subscription) → same header, with the
//     access token; the OAuth refresh path (PR #34/#35) keeps the token
//     fresh under the call site's existing `maybeRefreshOAuth` wrap.
//
// Returns the same `NonStreamUpstreamResult` / `StreamUpstreamResult`
// discriminated union as the Anthropic helper so route handlers can
// reuse most of the failover plumbing without per-platform branches
// in the loop body.

import { request } from "undici";
import type { ResolvedCredential } from "./resolveCredential.js";
import type {
  NonStreamUpstreamResult,
  StreamUpstreamResult,
  UpstreamResult,
} from "./upstreamCall.js";

export interface OpenAIUpstreamCallInput {
  baseUrl: string;
  body: Buffer | string;
  credential: ResolvedCredential;
  signal?: AbortSignal;
  /**
   * Headers the route handler wants to forward as-is — typically
   * empty.  Hop-by-hop / forbidden headers are stripped after merge.
   */
  forwardHeaders?: Record<string, string>;
  timeoutMs?: number;
}

function buildOpenAIAuthHeaders(
  credential: ResolvedCredential,
): Record<string, string> {
  // OpenAI uses `Authorization: Bearer <token>` for both sk-keys and
  // ChatGPT subscription OAuth tokens. The OAuth refresh API (PR #34/35)
  // keeps the access token fresh; we just read whatever is current.
  if (credential.type === "api_key") {
    return { authorization: `Bearer ${credential.apiKey}` };
  }
  return { authorization: `Bearer ${credential.accessToken}` };
}

function isStreamRequest(body: Buffer | string): boolean {
  try {
    const text = typeof body === "string" ? body : body.toString("utf8");
    const parsed = JSON.parse(text);
    return parsed?.stream === true;
  } catch {
    return false;
  }
}

export async function callUpstreamResponses(
  input: OpenAIUpstreamCallInput,
): Promise<UpstreamResult> {
  const url = new URL("/v1/responses", input.baseUrl).toString();

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    ...input.forwardHeaders,
    ...buildOpenAIAuthHeaders(input.credential),
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
    const result: StreamUpstreamResult = {
      kind: "stream",
      status: res.statusCode,
      headers: res.headers as Record<string, string | string[] | undefined>,
      body: res.body as unknown as AsyncIterable<Buffer>,
    };
    return result;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of res.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const result: NonStreamUpstreamResult = {
    kind: "non-stream",
    status: res.statusCode,
    headers: res.headers as Record<string, string | string[] | undefined>,
    body: Buffer.concat(chunks),
  };
  return result;
}
