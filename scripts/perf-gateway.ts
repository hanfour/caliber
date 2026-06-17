// Report-only gateway load benchmark (Task 16, plan #206).
//
// Drives `autocannon` against a freshly-booted load stack (testcontainer
// Postgres + Redis + the real gateway on an ephemeral port + a fake upstream)
// across a `surface × upstream-latency` matrix and writes a markdown report
// with environment metadata to `docs/perf/<date>-gateway-load.md`.
//
// This is NOT a CI gate — there are no threshold assertions. The success
// criterion is that it RUNS all surfaces × latencies and writes the report.
//
// Platform routing note (see apps/gateway/src/routes/dispatch.ts):
//   * `/v1/messages` defaults to the anthropic platform when the api key has
//     no group → driven by an ungrouped pool key bound to an anthropic account.
//   * `/v1/responses` dispatches by `group.platform`; the openai passthrough
//     branch needs an openai-platform group → driven by an openai-grouped key.
//   * `/backend-api/codex/responses` is wrapped in `forcePlatform("openai")`,
//     which returns 401 `group_required` without a group → also driven by the
//     openai-grouped key. Using one ungrouped key for all three would 401/4xx
//     the codex (and mis-route the responses) surface, yielding a useless
//     matrix, so we seed two keys and pick the right one per surface.
import autocannon from "autocannon";
import os from "node:os";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { bootStack } from "../apps/gateway/tests/load/bootStack.js";
import {
  seedOrg,
  seedUser,
  seedMembership,
  seedApiKey,
  seedAccount,
  seedGroup,
} from "../apps/gateway/tests/load/seed.js";

interface Surface {
  surface: string;
  route: string;
  body: Record<string, unknown>;
  /** "anthropic" → ungrouped pool key; "openai" → openai-grouped key. */
  platform: "anthropic" | "openai";
}

const SURFACES: Surface[] = [
  {
    surface: "messages",
    route: "/v1/messages",
    body: {
      model: "claude-3-haiku-20240307",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
    },
    platform: "anthropic",
  },
  {
    surface: "responses",
    route: "/v1/responses",
    body: { model: "gpt-4o", input: "hello" },
    platform: "openai",
  },
  {
    surface: "codex-responses",
    route: "/backend-api/codex/responses",
    body: { model: "gpt-4o", input: "hello" },
    platform: "openai",
  },
];

const LATENCIES = [0, 50, 200];

function parseArg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : def;
}

async function main(): Promise<void> {
  const connections = parseArg("connections", 50);
  const duration = parseArg("duration", 20);

  // Large maxWait/maxSwitches so the harness never bails under contention;
  // this is throughput measurement, not failover correctness. apikeyRpmLimit:0
  // disables the per-key rate limiter (default 600/min) so autocannon measures
  // gateway throughput rather than the limiter rejecting ~all requests with 429.
  const stack = await bootStack({
    maxWait: 100000,
    maxSwitches: 10,
    apikeyRpmLimit: 0,
  });

  const orgId = await seedOrg(stack.db, "perf");
  const userId = await seedUser(stack.db, "perf", 1);
  await seedMembership(stack.db, orgId, userId);

  // Key 1: ungrouped pool key → anthropic surface (/v1/messages).
  const anthropicKey = await seedApiKey(stack.db, orgId, userId, "perf", 1, "pool");
  // Key 2: openai-grouped key → /v1/responses + /backend-api/codex/responses.
  const openaiKey = await seedApiKey(stack.db, orgId, userId, "perf", 2, "pool");

  // Pool accounts (userId null), high concurrency so the slot cap never gates.
  await seedAccount(stack.db, orgId, "perf", 1, {
    userId: null,
    platform: "anthropic",
    concurrency: 100000,
  });
  const openaiAcct = await seedAccount(stack.db, orgId, "perf", 2, {
    userId: null,
    platform: "openai",
    concurrency: 100000,
  });
  await seedGroup(stack.db, orgId, "perf", "openai", openaiKey.apiKeyId, [
    openaiAcct.id,
  ]);

  const keyFor: Record<Surface["platform"], string> = {
    anthropic: anthropicKey.rawKey,
    openai: openaiKey.rawKey,
  };

  const rows: string[] = [];
  for (const s of SURFACES) {
    for (const latencyMs of LATENCIES) {
      stack.fake.reset(); // also zeroes latency → must set it AFTER reset
      stack.fake.setLatency(latencyMs);
      const opts = {
        url: `${stack.baseUrl}${s.route}`,
        connections,
        method: "POST" as const,
        headers: {
          authorization: `Bearer ${keyFor[s.platform]}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(s.body),
      };
      await autocannon({ ...opts, duration: 3 }); // warmup, discarded
      const r = await autocannon({ ...opts, duration });
      // Net gateway p50 = observed p50 minus the injected upstream latency.
      const net = Math.max(0, Math.round(r.latency.p50 - latencyMs));
      rows.push(
        `| ${s.surface} | ${latencyMs} | ${Math.round(r.requests.average)} | ${r.latency.p50} | ${r.latency.p97_5} | ${r.latency.p99} | ${r.latency.max} | ${r.non2xx} | ${stack.fake.requestCount()} | ${stack.fake.errorCount()} | ${net} |`,
      );
    }
  }

  const gitSha = execSync("git rev-parse --short HEAD").toString().trim();
  const date = execSync("date +%Y-%m-%d").toString().trim();
  const cpu = os.cpus()[0]?.model ?? "unknown";
  const md = [
    `# Gateway load report — ${date}`,
    "",
    "## Environment",
    "",
    `- git sha: ${gitSha}`,
    `- Node: ${process.version}`,
    `- OS/CPU: ${os.type()} ${os.release()} / ${cpu} x${os.cpus().length}`,
    `- connections: ${connections}, duration: ${duration}s`,
    `- payload: fixed small (see scripts/perf-gateway.ts SURFACES)`,
    `- fake latencies: ${LATENCIES.join("/")}ms`,
    `- env: GATEWAY_ENABLE_MODEL_ALIAS=false, GATEWAY_CACHE_TTL_SEC=0, no idempotency header`,
    `- surfaces: messages (ungrouped→anthropic), responses + codex-responses (openai-grouped key)`,
    "",
    "## Results",
    "",
    "| surface | upstream_ms | RPS | p50 | p95 | p99 | max | non2xx | fake_reqs | fake_errs | gw_net_p50 |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
    "> p95 column is autocannon's p97_5 (its nearest tracked percentile).",
    "> Streaming first-token vs stream-complete is a documented follow-up; this matrix covers non-stream surfaces for v1.",
  ].join("\n");

  writeFileSync(`docs/perf/${date}-gateway-load.md`, md);
  console.log(md);

  await stack.teardown();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
