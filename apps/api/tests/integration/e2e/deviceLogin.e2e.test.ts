import Fastify, { type FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { clientSessions, clientEvents, apiKeys } from "@caliber/db";
import {
  setupTestDb,
  makeOrg,
  makeUser,
  callerFor,
  makeTestRedis,
  defaultTestEnv,
} from "../../factories/index.js";
import { deviceAuthRoutes } from "../../../src/rest/deviceAuth.js";
import { devicesEnrollRoutes } from "../../../src/rest/devicesEnroll.js";
import { ingestRoutes } from "../../../src/rest/ingest.js";
import { agentConfigRoutes } from "../../../src/rest/agentConfig.js";

// Task 15 Step 1: scripted E2E proving the whole server-side device-code
// login pipeline as ONE sequence (Tasks 1-4): start -> approve (tRPC, stands
// in for the browser /device page) -> poll -> enroll -> ingest -> agent-config.
//
// One Fastify app registers the REST routes; the tRPC caller used for
// `approve` shares the SAME db + redis instances as the REST app so the
// approved flow/enrollment-token row are visible across both surfaces,
// exactly like the real deployment where they share process state.

let testDb: Awaited<ReturnType<typeof setupTestDb>>;
const redis = makeTestRedis();
let app: FastifyInstance;
let userId: string;

beforeAll(async () => {
  testDb = await setupTestDb();
  const org = await makeOrg(testDb.db);
  const user = await makeUser(testDb.db, { orgId: org.id });
  userId = user.id;

  app = Fastify({ logger: false });
  app.decorate("db", testDb.db);
  await app.register(deviceAuthRoutes(defaultTestEnv, redis));
  await app.register(devicesEnrollRoutes(defaultTestEnv));
  await app.register(ingestRoutes(defaultTestEnv));
  await app.register(agentConfigRoutes(defaultTestEnv));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

describe("device login -> ingest E2E (Tasks 1-4 as one flow)", () => {
  it("start -> approve(trpc) -> poll -> enroll -> ingest -> agent-config", async () => {
    // 1. POST /v1/device-auth/start
    const startRes = await app.inject({
      method: "POST",
      url: "/v1/device-auth/start",
      payload: {
        hostname: "e2e-host",
        os: "darwin",
        agentVersion: "0.2.0",
        cliVersion: "0.2.0",
      },
    });
    expect(startRes.statusCode).toBe(201);
    const { device_code, user_code } = startRes.json() as {
      device_code: string;
      user_code: string;
    };
    expect(device_code).toBeTruthy();
    expect(user_code).toMatch(/^[BCDFGHJKMNPQRSTVWXYZ23456789]{4}-[BCDFGHJKMNPQRSTVWXYZ23456789]{4}$/);

    // 2. Approve via the tRPC procedure for a seeded member (stands in for
    // the browser /device approval), sharing the SAME db + redis.
    const caller = await callerFor(
      testDb.db,
      userId,
      "member@e2e.test",
      defaultTestEnv,
      redis,
    );
    const approveRes = await caller.devices.deviceAuth.approve({
      userCode: user_code,
    });
    expect(approveRes.ok).toBe(true);

    // 3. POST /v1/device-auth/poll -> enrollment_token
    const pollRes = await app.inject({
      method: "POST",
      url: "/v1/device-auth/poll",
      payload: { device_code },
    });
    expect(pollRes.statusCode).toBe(200);
    const { enrollment_token } = pollRes.json() as { enrollment_token: string };
    expect(typeof enrollment_token).toBe("string");
    expect(enrollment_token.length).toBeGreaterThan(20);

    // 4. POST /v1/devices/enroll -> 201 + cda_* key
    const enrollRes = await app.inject({
      method: "POST",
      url: "/v1/devices/enroll",
      payload: {
        token: enrollment_token,
        hostname: "e2e-host",
        os: "darwin 25.3.0 arm64",
        agentVersion: "0.2.0",
      },
    });
    expect(enrollRes.statusCode).toBe(201);
    const { key: deviceKey, deviceId } = enrollRes.json() as {
      key: string;
      deviceId: string;
    };
    expect(deviceKey).toMatch(/^cda_/);
    expect(deviceId).toMatch(/^[0-9a-f-]{36}$/);

    // 5. POST /v1/ingest with the cda_* key -> 2xx
    const sessionId = `sess-e2e-${Date.now()}`;
    const eventId = `ev-e2e-${Date.now()}`;
    const ingestRes = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${deviceKey}` },
      payload: {
        agent_version: "0.2.0",
        redaction_mode: "metadata-only",
        sessions: [
          {
            session_id: sessionId,
            parent_session_id: null,
            source_client: "claude-code",
            static: {
              cwd: "/Users/e2e/proj",
              cli_version: "2.1.0",
              model_provider: "anthropic",
              base_instructions_hash: "sha256:e2e",
            },
            events: [
              {
                event_id: eventId,
                event_type: "user_message",
                timestamp: new Date().toISOString(),
                tokens: { input: 10, output: 20 },
              },
            ],
          },
        ],
      },
    });
    expect(ingestRes.statusCode).toBeGreaterThanOrEqual(200);
    expect(ingestRes.statusCode).toBeLessThan(300);
    const ingestBody = ingestRes.json() as {
      ingested: number;
      session_upserts: number;
      errors: unknown[];
    };
    expect(ingestBody.ingested).toBe(1);
    expect(ingestBody.session_upserts).toBe(1);
    expect(ingestBody.errors).toEqual([]);

    // 6. Query client_sessions + client_events -> the fixture rows landed.
    const [sessRow] = await testDb.db
      .select()
      .from(clientSessions)
      .where(eq(clientSessions.id, sessionId));
    expect(sessRow).toBeDefined();
    expect(sessRow!.deviceId).toBe(deviceId);
    expect(sessRow!.sourceClient).toBe("claude-code");

    const evRows = await testDb.db
      .select()
      .from(clientEvents)
      .where(eq(clientEvents.sessionId, sessionId));
    expect(evRows.length).toBeGreaterThanOrEqual(1);
    expect(evRows[0]!.deviceId).toBe(deviceId);

    // 7. GET /v1/agent-config with the cda_* key -> default poll interval.
    const configRes = await app.inject({
      method: "GET",
      url: "/v1/agent-config",
      headers: { authorization: `Bearer ${deviceKey}` },
    });
    expect(configRes.statusCode).toBe(200);
    expect(configRes.json()).toMatchObject({ poll_interval_seconds: 60 });
  });

  it("#256: start(provision_gateway) -> approve mints an own_then_pool key -> poll returns api_key + gateway_url", async () => {
    const startRes = await app.inject({
      method: "POST",
      url: "/v1/device-auth/start",
      payload: { hostname: "gw-host", os: "darwin", provision_gateway: true },
    });
    expect(startRes.statusCode).toBe(201);
    const { device_code, user_code } = startRes.json() as {
      device_code: string;
      user_code: string;
    };

    const caller = await callerFor(
      testDb.db,
      userId,
      "member@e2e.test",
      defaultTestEnv,
      redis,
    );
    await caller.devices.deviceAuth.approve({ userCode: user_code });

    const pollRes = await app.inject({
      method: "POST",
      url: "/v1/device-auth/poll",
      payload: { device_code },
    });
    expect(pollRes.statusCode).toBe(200);
    const body = pollRes.json() as {
      enrollment_token: string;
      api_key?: string;
      gateway_url?: string;
    };
    expect(body.enrollment_token).toBeTruthy();
    expect(body.api_key).toMatch(/^ak_/);
    expect(body.gateway_url).toBe(defaultTestEnv.GATEWAY_BASE_URL);

    // The minted key is own_then_pool, named for the device, owned by the user.
    const [key] = await testDb.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), eq(apiKeys.name, "gw-host (caliber login)")));
    expect(key).toBeDefined();
    expect(key!.routingPolicy).toBe("own_then_pool");
    expect(key!.status).toBe("active");
  });
});
