import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditLogs,
  credentialVault,
  upstreamAccounts,
  type Database,
} from "@caliber/db";
import { decryptCredential } from "@caliber/gateway-core";
import { cliAdminPoolRoutes } from "../../../src/rest/cliAdminPool.js";
import { cliAccessKey, hashCliAccessToken } from "../../../src/rest/deviceAuth.js";
import {
  defaultTestEnv,
  makeOrg,
  makeTestRedis,
  makeUser,
  setupTestDb,
} from "../../factories/index.js";

let testDb: Awaited<ReturnType<typeof setupTestDb>>;
let app: FastifyInstance;
const redis = makeTestRedis();
const env = { ...defaultTestEnv, ENABLE_ANTHROPIC_OAUTH: true };
let org: Awaited<ReturnType<typeof makeOrg>>;
let admin: Awaited<ReturnType<typeof makeUser>>;
let member: Awaited<ReturnType<typeof makeUser>>;

async function authorize(token: string, userId: string) {
  await redis.set(
    cliAccessKey(hashCliAccessToken(token)),
    JSON.stringify({ userId, orgId: org.id }),
    "EX",
    3600,
  );
}

beforeAll(async () => {
  testDb = await setupTestDb();
  org = await makeOrg(testDb.db);
  admin = await makeUser(testDb.db, {
    orgId: org.id,
    role: "org_admin",
    scopeType: "organization",
    scopeId: org.id,
  });
  member = await makeUser(testDb.db, { orgId: org.id });
  app = Fastify({ logger: false });
  app.decorate("db", testDb.db as Database);
  await app.register(cliAdminPoolRoutes(env, redis));
  await app.ready();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
  await testDb.stop();
});
beforeEach(async () => {
  await redis.flushall();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "oauth-access-secret",
          refresh_token: "oauth-refresh-secret",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ),
  );
});

async function start(token: string) {
  return app.inject({
    method: "POST",
    url: "/v1/cli/admin/pool/oauth/start",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      org: org.slug,
      name: "Claude Max shared",
      priority: 25,
      concurrency: 12,
    },
  });
}

describe("CLI admin shared-pool OAuth", () => {
  it("creates an encrypted organization-scoped pool account and audit row", async () => {
    const token = "cct_pool_admin";
    await authorize(token, admin.id);
    const started = await start(token);
    expect(started.statusCode).toBe(201);
    const authorization = started.json();
    const authUrl = new URL(authorization.auth_url);
    expect(authUrl.hostname).toBe("claude.ai");
    expect(authUrl.searchParams.get("state")).toBe(authorization.flow_id);

    const callback = `http://localhost:54545/callback?code=grant-code&state=${authorization.flow_id}`;
    const completed = await app.inject({
      method: "POST",
      url: "/v1/cli/admin/pool/oauth/complete",
      headers: { authorization: `Bearer ${token}` },
      payload: { flow_id: authorization.flow_id, pasted_value: callback },
    });
    expect(completed.statusCode).toBe(201);
    expect(completed.json()).toMatchObject({
      name: "Claude Max shared",
      platform: "anthropic",
      type: "oauth",
      scope: "organization",
      status: "active",
    });
    expect(JSON.stringify(completed.json())).not.toContain("oauth-access-secret");

    const accountId = completed.json().id as string;
    const [account] = await testDb.db
      .select()
      .from(upstreamAccounts)
      .where(eq(upstreamAccounts.id, accountId));
    expect(account).toMatchObject({
      orgId: org.id,
      userId: null,
      teamId: null,
      priority: 25,
      concurrency: 12,
      schedulable: true,
      status: "active",
    });
    const [vault] = await testDb.db
      .select()
      .from(credentialVault)
      .where(eq(credentialVault.accountId, accountId));
    const plaintext = decryptCredential({
      masterKeyHex: env.CREDENTIAL_ENCRYPTION_KEY!,
      accountId,
      sealed: {
        nonce: vault!.nonce,
        ciphertext: vault!.ciphertext,
        authTag: vault!.authTag,
      },
    });
    expect(JSON.parse(plaintext)).toMatchObject({
      type: "oauth",
      access_token: "oauth-access-secret",
      refresh_token: "oauth-refresh-secret",
    });
    const audits = await testDb.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.actorUserId, admin.id),
          eq(auditLogs.targetId, accountId),
          eq(auditLogs.action, "account.cli_pool_oauth_added"),
        ),
      );
    expect(audits).toHaveLength(1);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/cli/admin/pool/oauth/complete",
      headers: { authorization: `Bearer ${token}` },
      payload: { flow_id: authorization.flow_id, pasted_value: callback },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toEqual({ error: "oauth_flow_expired" });
  });

  it("rejects a member with a valid CLI token", async () => {
    const token = "cct_pool_member";
    await authorize(token, member.id);
    const response = await start(token);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "forbidden" });
  });

  it("binds completion to the admin identity that started the flow", async () => {
    const adminToken = "cct_pool_owner";
    const memberToken = "cct_pool_other";
    await authorize(adminToken, admin.id);
    await authorize(memberToken, member.id);
    const started = await start(adminToken);
    const authorization = started.json();
    const response = await app.inject({
      method: "POST",
      url: "/v1/cli/admin/pool/oauth/complete",
      headers: { authorization: `Bearer ${memberToken}` },
      payload: {
        flow_id: authorization.flow_id,
        pasted_value: `grant#${authorization.flow_id}`,
      },
    });
    expect(response.statusCode).toBe(403);
  });
});
