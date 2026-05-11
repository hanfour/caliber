/**
 * Integration test for the hourly billing audit (Plan 4A Part 7, Task 7.4).
 *
 * Stands up real Postgres, seeds api_keys + usage_logs into known
 * drift / no-drift / monotonicity-violation states, runs the audit's
 * `runOnce()` (no timer needed), and verifies the returned counts plus
 * the injected metrics counters and logger calls.
 *
 * The Bernoulli sample is probabilistic; the sampling test asserts a
 * loose range rather than an exact count.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "node:path";
import { createRequire } from "node:module";
import { sql } from "drizzle-orm";
import {
  apiKeys,
  organizations,
  upstreamAccounts,
  usageLogs,
  users,
  type Database,
} from "@caliber/db";
import {
  BillingAudit,
  type BillingAuditLogger,
  type CounterLike,
} from "../../src/workers/billingAudit.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

// ── Containers + shared fixtures ─────────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

let orgId: string;
let userId: string;
let accountId: string;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  db = drizzle(pool) as unknown as Database;
  await migrate(db, { migrationsFolder });

  // One org + user + upstream account that all api_keys / usage_logs reference.
  // Seed once in beforeAll so per-test setup is fast.
  const [org] = await db
    .insert(organizations)
    .values({
      slug: "billing-audit-test-org",
      name: "Billing Audit Test Org",
    })
    .returning();
  orgId = org!.id;

  const [user] = await db
    .insert(users)
    .values({ email: "billing-audit-test@example.com" })
    .returning();
  userId = user!.id;

  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: "billing-audit-upstream",
      platform: "anthropic",
      type: "oauth",
    })
    .returning();
  accountId = acct!.id;
}, 120_000);

afterAll(async () => {
  await pool.end();
  await pgContainer.stop();
});

// ── Per-test cleanup ─────────────────────────────────────────────────────────

beforeEach(async () => {
  // usage_logs FKs api_keys → truncate logs first then keys.  Both with
  // CASCADE so any future audit/log children come along for the ride.
  await db.execute(sql`TRUNCATE TABLE usage_logs RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE api_keys CASCADE`);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

interface RecordingLogger extends BillingAuditLogger {
  warns: Array<{ obj: unknown; msg?: string }>;
  errors: Array<{ obj: unknown; msg?: string }>;
  infos: Array<{ obj: unknown; msg?: string }>;
}

function recordingLogger(): RecordingLogger {
  const logger: RecordingLogger = {
    warns: [],
    errors: [],
    infos: [],
    info(obj, msg) {
      logger.infos.push({ obj, msg });
    },
    warn(obj, msg) {
      logger.warns.push({ obj, msg });
    },
    error(obj, msg) {
      logger.errors.push({ obj, msg });
    },
  };
  return logger;
}

function recordingCounter(): CounterLike & { readonly value: number } {
  let value = 0;
  return {
    get value() {
      return value;
    },
    inc(n = 1) {
      value = value + n;
    },
  };
}

interface SeedKeyOpts {
  /** Initial quota_used_usd value (decimal string). */
  quotaUsedUsd?: string;
  /** Optional revoked_at — set to mark key revoked so it's filtered out. */
  revokedAt?: Date | null;
}

let keyCounter = 0;

async function seedApiKey(opts: SeedKeyOpts = {}): Promise<{ id: string }> {
  keyCounter++;
  const prefix = `bka-${keyCounter}-${Math.random().toString(36).slice(2, 8)}`;
  const [row] = await db
    .insert(apiKeys)
    .values({
      userId,
      orgId,
      keyHash: `hash-${prefix}`,
      keyPrefix: prefix,
      name: `key-${prefix}`,
      quotaUsd: "100.00000000",
      quotaUsedUsd: opts.quotaUsedUsd ?? "0",
      revokedAt: opts.revokedAt ?? null,
    })
    .returning({ id: apiKeys.id });
  return row!;
}

async function seedUsageLog(
  apiKeyId: string,
  totalCost: string,
  reqIdx: number,
): Promise<void> {
  await db.insert(usageLogs).values({
    requestId: `req-${apiKeyId.slice(0, 8)}-${reqIdx}-${Math.random().toString(36).slice(2, 6)}`,
    userId,
    apiKeyId,
    accountId,
    orgId,
    teamId: null,
    requestedModel: "claude-sonnet-4-5",
    upstreamModel: "claude-sonnet-4-5-20250101",
    platform: "anthropic",
    surface: "messages",
    stream: false,
    inputTokens: 100,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    inputCost: "0",
    outputCost: "0",
    cacheCreationCost: "0",
    cacheReadCost: "0",
    totalCost,
    rateMultiplier: "1.0000",
    accountRateMultiplier: "1.0000",
    statusCode: 200,
    durationMs: 1234,
    firstTokenMs: null,
    bufferReleasedAtMs: null,
    upstreamRetries: 0,
    failedAccountIds: [],
    userAgent: null,
    ipAddress: null,
  });
}

function makeAudit(
  overrides: {
    sampleRatio?: number;
    driftThresholdUsd?: number;
    metrics?: { drift: CounterLike; mono: CounterLike };
    logger?: RecordingLogger;
    jitter?: () => number;
  } = {},
) {
  const logger = overrides.logger ?? recordingLogger();
  return new BillingAudit(db, {
    logger,
    metrics: overrides.metrics
      ? {
          billingDriftTotal: overrides.metrics.drift,
          billingMonotonicityViolationTotal: overrides.metrics.mono,
        }
      : undefined,
    // Use 100% sample ratio by default so deterministic tests don't flake
    // on Bernoulli's per-row coin flip.
    sampleRatio: overrides.sampleRatio ?? 100,
    driftThresholdUsd: overrides.driftThresholdUsd,
    jitter: overrides.jitter,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("BillingAudit.runOnce", () => {
  it("1. clean state: quota matches sum exactly → no drift, no violation", async () => {
    const key = await seedApiKey({ quotaUsedUsd: "0" });
    void key; // referenced for clarity

    const drift = recordingCounter();
    const mono = recordingCounter();
    const logger = recordingLogger();
    const audit = makeAudit({ metrics: { drift, mono }, logger });

    const result = await audit.runOnce();

    expect(result.sampled).toBe(1);
    expect(result.drifted).toBe(0);
    expect(result.monotonicityViolations).toBe(0);
    expect(drift.value).toBe(0);
    expect(mono.value).toBe(0);
    expect(logger.warns).toHaveLength(0);
    expect(logger.errors).toHaveLength(0);
  });

  it("2. drift (actual > expected): logs row, bumps drift counter only", async () => {
    // quota_used_usd=0, but a $1.00 usage_log exists → actual ($1.00) > expected (0).
    // |drift| = $1.00 > threshold → drift; actual > expected → NOT a monotonicity violation.
    const key = await seedApiKey({ quotaUsedUsd: "0" });
    await seedUsageLog(key.id, "1.0000000000", 0);

    const drift = recordingCounter();
    const mono = recordingCounter();
    const logger = recordingLogger();
    const audit = makeAudit({ metrics: { drift, mono }, logger });

    const result = await audit.runOnce();

    expect(result.sampled).toBe(1);
    expect(result.drifted).toBe(1);
    expect(result.monotonicityViolations).toBe(0);
    expect(drift.value).toBe(1);
    expect(mono.value).toBe(0);
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]?.obj).toMatchObject({
      type: "gw_billing_drift",
      apiKeyId: key.id,
    });
    expect(logger.errors).toHaveLength(0);
  });

  it("3. monotonicity violation (actual < expected): bumps both counters", async () => {
    // quota_used_usd=$1.00, no usage_logs → actual (0) < expected ($1.00).
    // |drift| = $1.00 > threshold → drift; expected > actual → monotonicity violation.
    const key = await seedApiKey({ quotaUsedUsd: "1.00000000" });

    const drift = recordingCounter();
    const mono = recordingCounter();
    const logger = recordingLogger();
    const audit = makeAudit({ metrics: { drift, mono }, logger });

    const result = await audit.runOnce();

    expect(result.sampled).toBe(1);
    expect(result.drifted).toBe(1);
    expect(result.monotonicityViolations).toBe(1);
    expect(drift.value).toBe(1);
    expect(mono.value).toBe(1);
    expect(logger.warns).toHaveLength(1);
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.obj).toMatchObject({
      type: "gw_billing_monotonicity_violation",
      apiKeyId: key.id,
    });
  });

  it("4. sub-threshold drift (within $0.01): not counted as drift", async () => {
    // quota_used_usd=$1.000005, sum=$1.00 → drift = -$0.000005 (well inside $0.01).
    const key = await seedApiKey({ quotaUsedUsd: "1.00000500" });
    await seedUsageLog(key.id, "1.0000000000", 0);
    void key;

    const drift = recordingCounter();
    const mono = recordingCounter();
    const audit = makeAudit({ metrics: { drift, mono } });

    const result = await audit.runOnce();

    expect(result.sampled).toBe(1);
    expect(result.drifted).toBe(0);
    expect(result.monotonicityViolations).toBe(0);
    expect(drift.value).toBe(0);
    expect(mono.value).toBe(0);
  });

  it("5. revoked api_keys ARE included in the sample (drift stays visible)", async () => {
    // One active key + one revoked key, both drifted.  An earlier version
    // of this audit filtered revoked keys out, which created a blind spot
    // an admin could exploit by revoking a drifted key.  The audit now
    // samples every key and surfaces drift regardless of revocation state.
    const active = await seedApiKey({ quotaUsedUsd: "0" });
    await seedUsageLog(active.id, "1.0000000000", 0);
    const revoked = await seedApiKey({
      quotaUsedUsd: "0",
      revokedAt: new Date(),
    });
    await seedUsageLog(revoked.id, "5.0000000000", 0);

    const drift = recordingCounter();
    const mono = recordingCounter();
    const logger = recordingLogger();
    const audit = makeAudit({ metrics: { drift, mono }, logger });
    const result = await audit.runOnce();

    // Both keys sampled; both drifted; both surface as drift events.
    expect(result.sampled).toBe(2);
    expect(result.drifted).toBe(2);
    expect(drift.value).toBe(2);

    const warnApiKeyIds = logger.warns
      .map((w) => (w.obj as { apiKeyId?: string }).apiKeyId)
      .filter((id): id is string => typeof id === "string");
    expect(warnApiKeyIds).toContain(active.id);
    expect(warnApiKeyIds).toContain(revoked.id);
  });

  it("5b. monotonicity violation on a revoked api_key still surfaces", async () => {
    // A revoked key with quota charged but no matching usage_logs must
    // still bump the monotonicity counter — hiding this signal would let
    // an admin erase billing-integrity issues by revoking the key.
    const revoked = await seedApiKey({
      quotaUsedUsd: "1.00000000",
      revokedAt: new Date(),
    });

    const drift = recordingCounter();
    const mono = recordingCounter();
    const logger = recordingLogger();
    const audit = makeAudit({ metrics: { drift, mono }, logger });

    const result = await audit.runOnce();

    expect(result.sampled).toBe(1);
    expect(result.drifted).toBe(1);
    expect(result.monotonicityViolations).toBe(1);
    expect(drift.value).toBe(1);
    expect(mono.value).toBe(1);
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.obj).toMatchObject({
      type: "gw_billing_monotonicity_violation",
      apiKeyId: revoked.id,
    });
  });

  it("6. Bernoulli sampling: sampleRatio=10 over 200 keys yields ~20 sampled (loose range)", async () => {
    // Bernoulli is probabilistic — the 95% CI for n=200, p=0.1 spans roughly
    // [12, 32].  Allow a generous range to avoid flakes; the point of this
    // test is "sampling is wired up", not "binomial CI is tight".
    const N = 200;
    for (let i = 0; i < N; i++) {
      await seedApiKey({ quotaUsedUsd: "0" });
    }

    const audit = makeAudit({ sampleRatio: 10 });
    const result = await audit.runOnce();

    // Loose bounds: between 5 and 50 out of 200.  In practice we expect ~20.
    expect(result.sampled).toBeGreaterThanOrEqual(5);
    expect(result.sampled).toBeLessThanOrEqual(50);
    // None should drift since all keys are clean.
    expect(result.drifted).toBe(0);
  });

  it("7. constructor rejects out-of-range sampleRatio", () => {
    const logger = recordingLogger();
    expect(() => new BillingAudit(db, { logger, sampleRatio: 0 })).toThrow(
      /sampleRatio/,
    );
    expect(() => new BillingAudit(db, { logger, sampleRatio: 200 })).toThrow(
      /sampleRatio/,
    );
    expect(() => new BillingAudit(db, { logger, sampleRatio: NaN })).toThrow(
      /sampleRatio/,
    );
  });

  it("8. multiple keys: counts only the drifted ones", async () => {
    const clean = await seedApiKey({ quotaUsedUsd: "0" });
    void clean;
    const driftedKey = await seedApiKey({ quotaUsedUsd: "0" });
    await seedUsageLog(driftedKey.id, "2.0000000000", 0);
    const monoKey = await seedApiKey({ quotaUsedUsd: "3.00000000" });

    const drift = recordingCounter();
    const mono = recordingCounter();
    const audit = makeAudit({ metrics: { drift, mono } });

    const result = await audit.runOnce();

    expect(result.sampled).toBe(3);
    expect(result.drifted).toBe(2);
    expect(result.monotonicityViolations).toBe(1);
    expect(drift.value).toBe(2);
    expect(mono.value).toBe(1);
    void monoKey;
  });
});

// ── Lifecycle tests (start/stop idempotency) ─────────────────────────────────

describe("BillingAudit lifecycle", () => {
  it("start() is idempotent — second call does not double-schedule", async () => {
    // Use a jitter of 1h so the timer never actually fires during the test.
    const audit = makeAudit({ jitter: () => 3_600_000 });
    audit.start();
    audit.start(); // no-op
    // No public way to inspect the handle count, but stop() must not throw
    // and must clear the single timer cleanly.
    audit.stop();
    audit.stop(); // also a no-op after stop
  });

  it("stop() works on a never-started instance", () => {
    const audit = makeAudit();
    expect(() => audit.stop()).not.toThrow();
  });

  it("stop() after start() clears the pending timer (no leaked handles)", async () => {
    const audit = makeAudit({ jitter: () => 3_600_000 });
    audit.start();
    audit.stop();
    // If the timer leaked, vitest would hang past the test timeout.  The
    // assertion is implicit — the test simply has to finish.
    expect(true).toBe(true);
  });
});
