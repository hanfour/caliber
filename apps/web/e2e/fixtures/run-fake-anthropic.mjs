#!/usr/bin/env node
/**
 * Standalone fake Anthropic upstream for E2E.
 *
 * Self-contained plain ESM — runs under `node` directly, no tsx / pnpm exec
 * wrapper chain. Deliberately duplicated from fake-anthropic.ts rather than
 * imported, because `pnpm --filter @caliber/web exec tsx …` via nohup was
 * producing a live-but-unreachable child on GitHub Actions runners (the
 * server logged "listening" but wait-on timed out). A plain `node` call
 * has no such ambiguity.
 *
 * Run with:
 *   FAKE_ANTHROPIC_PORT=4100 node apps/web/e2e/fixtures/run-fake-anthropic.mjs
 *
 * Stays alive until SIGTERM / SIGINT.
 */

import { createServer } from "node:http";

const port = Number(process.env.FAKE_ANTHROPIC_PORT ?? 4100);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[fake-anthropic] invalid FAKE_ANTHROPIC_PORT=${process.env.FAKE_ANTHROPIC_PORT}`);
  process.exit(1);
}

const CANNED_MESSAGE_RESPONSE = {
  id: "msg_fake_e2e",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "ok" }],
  model: "claude-3-haiku-20240307",
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 1 },
};

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const server = createServer((req, res) => {
  void (async () => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    // Consume body for POST so connections close cleanly even on unknown paths.
    if (method === "POST") await readBody(req);

    // GET / + /health are wait-on / webServer readiness probes. Accept HEAD
    // too — wait-on 9.x issues HEAD by default for HTTP URLs; a bare GET-only
    // handler would fall through to the 404 path and cause wait-on to retry
    // until the 120s timeout elapses.
    if (
      (method === "GET" || method === "HEAD") &&
      (url === "/" || url === "/health")
    ) {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === "POST" && url === "/v1/messages") {
      sendJson(res, 200, CANNED_MESSAGE_RESPONSE);
      return;
    }
    sendJson(res, 404, { error: "not_found" });
  })().catch((err) => {
    sendJson(res, 500, { error: "fake_upstream_failure", detail: String(err) });
  });
});

// Drop the host argument so Node picks its dual-stack default (::) on
// systems with bindv6only=0, falling back to 0.0.0.0 otherwise. Matters on
// GitHub Actions runners where `localhost` resolution order is variable.
// Explicit 0.0.0.0 forces IPv4 binding — CI runners with bindv6only=1 would
// otherwise reject IPv4 connects when we default to `::`. Log the raw
// address() output too, so next-failure diagnostics aren't ambiguous.
server.listen(port, "0.0.0.0", () => {
  const addr = server.address();
  console.log(
    `[fake-anthropic] listening on http://localhost:${port} (addr=${JSON.stringify(addr)}, pid=${process.pid})`,
  );
});

server.on("close", () => {
  console.log("[fake-anthropic] server close event");
});
server.on("error", (err) => {
  console.error("[fake-anthropic] server error", err);
});
process.on("exit", (code) => {
  console.log(`[fake-anthropic] process exit code=${code}`);
});
process.on("uncaughtException", (err) => {
  console.error("[fake-anthropic] uncaughtException", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[fake-anthropic] unhandledRejection", reason);
});

const shutdown = (signal) => {
  console.log(`[fake-anthropic] received ${signal}, closing…`);
  server.close((err) => {
    if (err) {
      console.error("[fake-anthropic] close failed", err);
      process.exit(1);
    }
    process.exit(0);
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
