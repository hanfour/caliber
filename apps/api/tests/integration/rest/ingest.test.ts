import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { gzipSync } from "node:zlib";
import { eq, sql } from "drizzle-orm";
import {
  devices,
  deviceApiKeys,
  clientSessions,
  clientEvents,
} from "@caliber/db";
import {
  generateDeviceKey,
  hashDeviceKey,
} from "@caliber/gateway-core";
import {
  setupTestDb,
  makeOrg,
  makeUser,
  defaultTestEnv,
} from "../../factories/index.js";
import { ingestRoutes } from "../../../src/rest/ingest.js";

let testDb: Awaited<ReturnType<typeof setupTestDb>>;
let app: FastifyInstance;

async function buildApp() {
  const fastify = Fastify({ logger: false });
  fastify.decorate("db", testDb.db);
  await fastify.register(ingestRoutes(defaultTestEnv));
  return fastify;
}

interface DeviceFixture {
  deviceId: string;
  userId: string;
  orgId: string;
  rawKey: string;
}

async function seedDevice(opts?: {
  status?: string;
  revokedAt?: Date | null;
}): Promise<DeviceFixture> {
  const org = await makeOrg(testDb.db);
  const user = await makeUser(testDb.db, { orgId: org.id });

  const [device] = await testDb.db
    .insert(devices)
    .values({
      userId: user.id,
      orgId: org.id,
      hostname: "test-host",
      os: "darwin",
      agentVersion: "0.1.0",
      status: opts?.status ?? "active",
      revokedAt: opts?.revokedAt ?? null,
    })
    .returning({ id: devices.id });

  const { raw, prefix } = generateDeviceKey();
  const keyHash = hashDeviceKey(defaultTestEnv.API_KEY_HASH_PEPPER!, raw);
  await testDb.db.insert(deviceApiKeys).values({
    deviceId: device!.id,
    keyHash,
    keyPrefix: prefix,
  });

  return {
    deviceId: device!.id,
    userId: user.id,
    orgId: org.id,
    rawKey: raw,
  };
}

const isoNow = () => new Date().toISOString();

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: `ev-${Math.random().toString(36).slice(2)}`,
    event_type: "user_message",
    timestamp: isoNow(),
    tokens: { input: 10, output: 20 },
    ...overrides,
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    session_id: `sess-${Math.random().toString(36).slice(2)}`,
    parent_session_id: null,
    source_client: "claude-code",
    static: {
      cwd: "/Users/x/proj",
      cli_version: "2.1.0",
      model_provider: "anthropic",
      base_instructions_hash: "sha256:abc",
    },
    events: [makeEvent(), makeEvent(), makeEvent()],
    ...overrides,
  };
}

beforeAll(async () => {
  testDb = await setupTestDb();
});

afterAll(async () => {
  await testDb.stop();
});

describe("POST /v1/ingest", () => {
  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await testDb.db.execute(sql`DELETE FROM client_events`);
    await testDb.db.execute(sql`DELETE FROM client_sessions`);
  });

  it("happy path: 200, ingests events, upserts session, server overrides device_id from auth", async () => {
    const fx = await seedDevice();
    const session = makeSession();

    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${fx.rawKey}` },
      payload: {
        device_id: "00000000-0000-0000-0000-000000000000", // server must IGNORE this
        agent_version: "0.1.0",
        redaction_mode: "metadata-only",
        sessions: [session],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ingested).toBe(3);
    expect(body.deduped).toBe(0);
    expect(body.session_upserts).toBe(1);
    expect(body.errors).toEqual([]);

    // Session row written with server-determined tenant chain.
    const [sessRow] = await testDb.db
      .select()
      .from(clientSessions)
      .where(eq(clientSessions.id, session.session_id));
    expect(sessRow!.deviceId).toBe(fx.deviceId);
    expect(sessRow!.userId).toBe(fx.userId);
    expect(sessRow!.orgId).toBe(fx.orgId);
    expect(sessRow!.sourceClient).toBe("claude-code");

    // 3 events landed, all tagged with the resolved device + org.
    const evs = await testDb.db
      .select()
      .from(clientEvents)
      .where(eq(clientEvents.sessionId, session.session_id));
    expect(evs).toHaveLength(3);
    for (const ev of evs) {
      expect(ev.orgId).toBe(fx.orgId);
      expect(ev.deviceId).toBe(fx.deviceId);
      expect(ev.source).toBe("transcript");
    }
  });

  // #174: a single chunk with >4095 events used to overflow Postgres's
  // 65535 bind-param cap (client_events binds 16 cols/row, 16*N > 65535),
  // failing the whole INSERT with pg 54000 → events_insert_failed → the
  // entire session's events silently dropped. The INSERT must be batched.
  it("large batch: >4095 events in one session ingest fully (bind-param batching)", async () => {
    const fx = await seedDevice();
    const N = 5000; // 16 * 5000 = 80000 > 65535 → overflows a single INSERT
    const events = Array.from({ length: N }, (_, i) =>
      makeEvent({ event_id: `ev-large-${i}` }),
    );
    const session = makeSession({ events });

    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${fx.rawKey}` },
      payload: {
        agent_version: "0.1.0",
        redaction_mode: "metadata-only",
        sessions: [session],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.errors).toEqual([]);
    expect(body.ingested).toBe(N);
    expect(body.deduped).toBe(0);

    const rows = await testDb.db
      .select()
      .from(clientEvents)
      .where(eq(clientEvents.sessionId, session.session_id));
    expect(rows).toHaveLength(N);
  });

  it("retry dedup: same payload twice → second call returns deduped:N, ingested:0", async () => {
    const fx = await seedDevice();
    const session = makeSession();
    const payload = {
      agent_version: "0.1.0",
      redaction_mode: "metadata-only",
      sessions: [session],
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${fx.rawKey}` },
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().ingested).toBe(3);

    const second = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${fx.rawKey}` },
      payload,
    });
    expect(second.statusCode).toBe(200);
    const body = second.json();
    expect(body.ingested).toBe(0);
    expect(body.deduped).toBe(3);
    expect(body.session_upserts).toBe(1); // upsert is a no-op update, still counted
  });

  it("cross-org collision: session_id owned by another org → 409 SESSION_OWNED_BY_OTHER_ORG", async () => {
    const fxA = await seedDevice();
    const fxB = await seedDevice();
    const sessionId = `sess-collide-${Date.now()}`;

    // org A claims the session first.
    const first = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${fxA.rawKey}` },
      payload: {
        agent_version: "0.1.0",
        redaction_mode: "metadata-only",
        sessions: [makeSession({ session_id: sessionId })],
      },
    });
    expect(first.statusCode).toBe(200);

    // org B tries to write to same session_id.
    const collide = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${fxB.rawKey}` },
      payload: {
        agent_version: "0.1.0",
        redaction_mode: "metadata-only",
        sessions: [makeSession({ session_id: sessionId })],
      },
    });
    expect(collide.statusCode).toBe(409);
    expect(collide.json().error).toBe("SESSION_OWNED_BY_OTHER_ORG");

    // The session row still belongs to org A.
    const [sessRow] = await testDb.db
      .select({ orgId: clientSessions.orgId })
      .from(clientSessions)
      .where(eq(clientSessions.id, sessionId));
    expect(sessRow!.orgId).toBe(fxA.orgId);
  });

  it("revoked device → 401", async () => {
    const fx = await seedDevice({
      status: "revoked",
      revokedAt: new Date(),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${fx.rawKey}` },
      payload: {
        agent_version: "0.1.0",
        redaction_mode: "metadata-only",
        sessions: [makeSession()],
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("device_revoked");
  });

  it("unknown/invalid bearer → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: "Bearer cda_thisdoesnotmatchanyhash" },
      payload: {
        agent_version: "0.1.0",
        redaction_mode: "metadata-only",
        sessions: [makeSession()],
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_token");
  });

  it("missing Authorization header → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      payload: {
        agent_version: "0.1.0",
        redaction_mode: "metadata-only",
        sessions: [makeSession()],
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("missing_token");
  });

  it("non-cda_* bearer → 401 (defense against ak_* keys being submitted)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: "Bearer ak_someothertypeofkey1234567890" },
      payload: {
        agent_version: "0.1.0",
        redaction_mode: "metadata-only",
        sessions: [makeSession()],
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_token");
  });

  it("malformed event in batch: zod-invalid events are skipped + reported, valid ones still ingest", async () => {
    const fx = await seedDevice();
    const goodEvent = makeEvent({ event_id: "good-1" });
    const session = makeSession({
      session_id: `sess-partial-${Date.now()}`,
      events: [
        goodEvent,
        { event_id: "", event_type: "user_message", timestamp: isoNow() }, // empty event_id
        { event_id: "bad-ts", event_type: "user_message", timestamp: "not-a-date" }, // unparseable timestamp
      ],
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${fx.rawKey}` },
      payload: {
        agent_version: "0.1.0",
        redaction_mode: "metadata-only",
        sessions: [session],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ingested).toBe(1);
    expect(body.deduped).toBe(0);
    expect(body.session_upserts).toBe(1);
    expect(body.errors.length).toBe(2);
    expect(body.errors.some((e: { error: string }) => e.error === "invalid_timestamp")).toBe(true);
  });

  it("invalid body shape (zod fail at top level) → 400", async () => {
    const fx = await seedDevice();
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${fx.rawKey}` },
      payload: { agent_version: "0.1.0" }, // missing redaction_mode + sessions
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
    // Bare error code only — no zod flatten() echo (matches deviceAuth.ts).
    expect(res.json().details).toBeUndefined();
  });

  it("gateway disabled → 404", async () => {
    const disabledApp = Fastify({ logger: false });
    disabledApp.decorate("db", testDb.db);
    await disabledApp.register(
      ingestRoutes({ ...defaultTestEnv, ENABLE_GATEWAY: false }),
    );

    const res = await disabledApp.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: "Bearer cda_anything" },
      payload: {
        agent_version: "0.1.0",
        redaction_mode: "metadata-only",
        sessions: [makeSession()],
      },
    });
    expect(res.statusCode).toBe(404);
    await disabledApp.close();
  });

  it("gzip-encoded body is decoded transparently", async () => {
    const fx = await seedDevice();
    const session = makeSession();
    const json = JSON.stringify({
      agent_version: "0.1.0",
      redaction_mode: "metadata-only",
      sessions: [session],
    });
    const gz = gzipSync(Buffer.from(json, "utf8"));

    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        authorization: `Bearer ${fx.rawKey}`,
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      payload: gz,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ingested).toBe(3);
  });

  it("device.last_seen_at is bumped on successful ingest", async () => {
    const fx = await seedDevice();
    // Backdate last_seen_at so we can detect the bump.
    await testDb.db
      .update(devices)
      .set({ lastSeenAt: new Date("2000-01-01T00:00:00Z") })
      .where(eq(devices.id, fx.deviceId));

    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${fx.rawKey}` },
      payload: {
        agent_version: "0.1.0",
        redaction_mode: "metadata-only",
        sessions: [makeSession()],
      },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await testDb.db
      .select({ lastSeenAt: devices.lastSeenAt })
      .from(devices)
      .where(eq(devices.id, fx.deviceId));
    expect(row!.lastSeenAt.getTime()).toBeGreaterThan(
      new Date("2020-01-01T00:00:00Z").getTime(),
    );
  });
});

// Audit 2026-05-20 finding #4 — auth runs before the gzip parser so an
// unauthenticated bomb is rejected with 401 before any decompression
// happens; authenticated payloads that decode beyond the cap return 413.
describe("POST /v1/ingest gzip auth + decompressed-size cap", () => {
  let cappedApp: FastifyInstance;
  // Tiny cap so the test doesn't have to gzip 200MB worth of zeros.
  const CAP_BYTES = 8 * 1024; // 8 KB
  const cappedEnv = {
    ...defaultTestEnv,
    INGEST_MAX_DECOMPRESSED_BYTES: CAP_BYTES,
  };

  beforeAll(async () => {
    cappedApp = Fastify({ logger: false });
    cappedApp.decorate("db", testDb.db);
    await cappedApp.register(ingestRoutes(cappedEnv));
  });

  afterAll(async () => {
    await cappedApp.close();
  });

  it("unauthenticated request with a gzip bomb is rejected with 401, parser never runs", async () => {
    // Compress a payload that, if decoded, would breach CAP_BYTES.
    // Highly compressible 64 KB of zeros yields a small gzip wire size but
    // decodes well past the 8 KB cap. With auth-before-parse, the request
    // 401s before gunzip ever touches the buffer.
    const bomb = gzipSync(Buffer.alloc(CAP_BYTES * 8, 0));
    const res = await cappedApp.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { "content-encoding": "gzip", "content-type": "application/json" },
      payload: bomb,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("missing_token");
  });

  it("authenticated request whose decoded body exceeds the cap returns 413", async () => {
    const fx = await seedDevice();
    const bomb = gzipSync(Buffer.alloc(CAP_BYTES * 8, 0));
    const res = await cappedApp.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        authorization: `Bearer ${fx.rawKey}`,
        "content-encoding": "gzip",
        "content-type": "application/json",
      },
      payload: bomb,
    });
    expect(res.statusCode).toBe(413);
  });

  it("authenticated request whose decoded body is under the cap still succeeds", async () => {
    const fx = await seedDevice();
    const body = JSON.stringify({
      agent_version: "0.1.0",
      redaction_mode: "metadata-only",
      sessions: [makeSession()],
    });
    // Under the 8 KB cap for a 1-session payload.
    const compressed = gzipSync(Buffer.from(body, "utf8"));
    const res = await cappedApp.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        authorization: `Bearer ${fx.rawKey}`,
        "content-encoding": "gzip",
        "content-type": "application/json",
      },
      payload: compressed,
    });
    expect(res.statusCode).toBe(200);
  });
});
