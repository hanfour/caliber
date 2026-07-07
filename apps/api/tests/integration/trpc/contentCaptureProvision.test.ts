import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { apiKeys } from "@caliber/db";
import {
  setupTestDb,
  makeOrg,
  makeUser,
  callerFor,
  makeTestRedis,
} from "../../factories/index.js";

let t: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  await t.stop();
});

describe("setSettings provisions the eval key", () => {
  it("creates the Redis eval key on false→true, idempotent on re-enable", async () => {
    const redis: Redis = makeTestRedis();
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor(t.db, admin.id, "x@x.test", undefined, redis);

    await caller.contentCapture.setSettings({
      orgId: org.id,
      patch: { llmEvalEnabled: true, llmEvalModel: "claude-haiku-4-5" },
    });

    const raw = await redis.get(`llm-eval-key:${org.id}`);
    expect(raw).toMatch(/^caliber-eval-[0-9a-f]{64}$/);

    const keyRows = await t.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.orgId, org.id));
    const evalKey = keyRows.find(
      (k) => k.status === "active" && k.keyPrefix === "caliber-eval",
    );
    expect(evalKey).toBeDefined();

    // Explicit true→true re-affirmation must NOT rotate the key (idempotent).
    await caller.contentCapture.setSettings({
      orgId: org.id,
      patch: { llmEvalEnabled: true, llmEvalModel: "claude-sonnet-5" },
    });
    const rawAfter = await redis.get(`llm-eval-key:${org.id}`);
    expect(rawAfter).toBe(raw);
  });

  it("does not provision when llmEvalEnabled is not being turned on", async () => {
    const redis: Redis = makeTestRedis();
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor(t.db, admin.id, "x@x.test", undefined, redis);

    await caller.contentCapture.setSettings({
      orgId: org.id,
      patch: { contentCaptureEnabled: true },
    });

    const raw = await redis.get(`llm-eval-key:${org.id}`);
    expect(raw).toBeNull();
  });
});
