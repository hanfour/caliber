// apps/api/tests/integration/rest/redactionSet.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  devices,
  deviceApiKeys,
  orgRedactionPatterns,
  type RedactionPattern,
} from "@caliber/db";
import { generateDeviceKey, hashDeviceKey } from "@caliber/gateway-core";
import { setupTestDb, makeOrg, makeUser, defaultTestEnv } from "../../factories/index.js";
import {
  redactionSetRoutes,
  SERVER_DEFAULT_PATTERNS,
} from "../../../src/rest/redactionSet.js";

let testDb: Awaited<ReturnType<typeof setupTestDb>>;
let app: FastifyInstance;

async function buildApp() {
  const fastify = Fastify({ logger: false });
  fastify.decorate("db", testDb.db);
  await fastify.register(redactionSetRoutes(defaultTestEnv));
  return fastify;
}

async function seedActiveDevice(): Promise<{ deviceId: string; rawKey: string; orgId: string }> {
  const org = await makeOrg(testDb.db);
  const user = await makeUser(testDb.db, { orgId: org.id });
  const [dev] = await testDb.db
    .insert(devices)
    .values({
      userId: user.id,
      orgId: org.id,
      hostname: "h",
      os: "darwin",
      agentVersion: "test",
      status: "active",
    })
    .returning({ id: devices.id });
  if (!dev) throw new Error("device insert failed");
  const { raw, prefix } = generateDeviceKey();
  const keyHash = hashDeviceKey(defaultTestEnv.API_KEY_HASH_PEPPER!, raw);
  await testDb.db.insert(deviceApiKeys).values({ deviceId: dev.id, keyHash, keyPrefix: prefix });
  return { deviceId: dev.id, rawKey: raw, orgId: org.id };
}

describe("GET /v1/redaction-set", () => {
  beforeAll(async () => {
    testDb = await setupTestDb();
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await testDb.stop();
  });

  it("returns default patterns when no org row exists", async () => {
    const { rawKey } = await seedActiveDevice();
    const res = await app.inject({
      method: "GET",
      url: "/v1/redaction-set",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      patterns: RedactionPattern[];
      version: string;
      ttl_seconds: number;
    };
    expect(body.patterns).toEqual(SERVER_DEFAULT_PATTERNS);
    expect(body.version).toMatch(/^default-[a-f0-9]{8}$/);
    expect(body.ttl_seconds).toBe(86400);
  });

  it("returns custom patterns when org row exists", async () => {
    const { rawKey, orgId } = await seedActiveDevice();
    const custom: RedactionPattern[] = [
      { name: "internal", regex: "INT-[0-9]{6}", replacement: "INT-***" },
    ];
    await testDb.db.insert(orgRedactionPatterns).values({ orgId, patterns: custom });

    const res = await app.inject({
      method: "GET",
      url: "/v1/redaction-set",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.patterns).toEqual(custom);
    expect(body.version).toMatch(/^org-/);
  });

  it("rejects missing token with 401 missing_token", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/redaction-set" });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "missing_token" });
  });

  it("404s (before auth) when the gateway is disabled", async () => {
    const off = Fastify({ logger: false });
    off.decorate("db", testDb.db);
    await off.register(
      redactionSetRoutes({ ...defaultTestEnv, ENABLE_GATEWAY: false }),
    );
    const res = await off.inject({ method: "GET", url: "/v1/redaction-set" });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "not_found" });
    await off.close();
  });

  it("rejects malformed token with 401 invalid_token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/redaction-set",
      headers: { authorization: "Bearer wrong-prefix" },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid_token" });
  });

  it("rejects revoked key with 401 key_revoked", async () => {
    const { rawKey, deviceId } = await seedActiveDevice();
    await testDb.db
      .update(deviceApiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(deviceApiKeys.deviceId, deviceId));
    const res = await app.inject({
      method: "GET",
      url: "/v1/redaction-set",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "key_revoked" });
  });
});

describe("SERVER_DEFAULT_PATTERNS / agent DefaultPatterns parity", () => {
  it("server and agent default sets match by Name + RegexSrc + Replacement", () => {
    const goPath = join(
      __dirname, "..", "..", "..", "..", "..",
      "agent", "redact", "regexes.go",
    );
    const goSource = readFileSync(goPath, "utf8");
    const re = /\{Name:\s*"([^"]+)",\s*RegexSrc:\s*`([^`]+)`,\s*Replacement:\s*"([^"]+)"\}/g;
    const goEntries: { name: string; regex: string; replacement: string }[] = [];
    for (const m of goSource.matchAll(re)) {
      goEntries.push({ name: m[1]!, regex: m[2]!, replacement: m[3]! });
    }
    expect(goEntries.length).toBeGreaterThan(0);
    expect(goEntries).toEqual(SERVER_DEFAULT_PATTERNS);
  });
});
