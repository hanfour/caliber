/**
 * Integration tests for Task 1 and Task 2 BYOK schema changes.
 *
 * Task 1 — upstream_accounts.user_id ownership column:
 *   Verifies the user_id XOR team_id CHECK constraint and that user-owned,
 *   team-owned, and org-pooled upstreams are all accepted correctly.
 *
 * Task 2 — api_keys.routing_policy column:
 *   Verifies the routing_policy default ('pool'), the mutex CHECK constraint
 *   that rejects a non-pool policy when group_id is set, the enum CHECK that
 *   rejects unknown policy values, and that a non-pool policy without a
 *   group_id (e.g. 'own') inserts successfully.
 *
 * Stands up a real Postgres testcontainer and migrates the full schema before
 * running all assertions.
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
import { organizations, teams, users, upstreamAccounts, apiKeys, accountGroups, type Database } from "@caliber/db";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

// ── Postgres container ────────────────────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

// Shared parent FK rows
let orgId: string;
let userId: string;
let teamId: string;
let groupId: string;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  pool.on("error", () => {});  // swallow 57P01 admin-shutdown on container teardown
  db = drizzle(pool) as unknown as Database;
  await migrate(db as never, { migrationsFolder });

  // Seed one org
  const [org] = await db
    .insert(organizations)
    .values({ slug: "byok-schema-test-org", name: "BYOK Schema Test Org" })
    .returning();
  orgId = org!.id;

  // Seed one user
  const [user] = await db
    .insert(users)
    .values({ email: "byok-schema-test@example.com" })
    .returning();
  userId = user!.id;

  // Seed one team
  const [team] = await db
    .insert(teams)
    .values({ orgId, name: "BYOK Schema Test Team", slug: "byok-schema-test-team" })
    .returning();
  teamId = team!.id;

  // Seed one account group (needed for routing_policy tests)
  const [group] = await db
    .insert(accountGroups)
    .values({ orgId, name: "BYOK Schema Test Group", platform: "openai" })
    .returning();
  groupId = group!.id;
}, 90_000);

afterAll(async () => {
  await pool.end();
  await pgContainer.stop();
}, 30_000);

// ── Per-test cleanup ──────────────────────────────────────────────────────────

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE TABLE api_keys, upstream_accounts RESTART IDENTITY CASCADE`,
  );
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("upstream_accounts user_id column", () => {
  it("upstream_accounts CHECK rejects a row with both user_id and team_id set", async () => {
    let caughtError: unknown;
    try {
      await db.insert(upstreamAccounts).values({
        orgId,
        teamId,
        userId,
        name: "bad",
        platform: "openai",
        type: "api_key",
      });
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBeDefined();
    const directConstraint = (caughtError as { constraint?: string }).constraint;
    const causeConstraint = (caughtError as { cause?: { constraint?: string } }).cause?.constraint;
    const constraint = directConstraint ?? causeConstraint;
    expect(constraint).toBe("upstream_accounts_user_id_xor_team_id");
  });

  it("accepts a user-owned upstream (user_id set, team_id null)", async () => {
    const [row] = await db
      .insert(upstreamAccounts)
      .values({
        orgId,
        userId,
        name: "byok",
        platform: "openai",
        type: "api_key",
      })
      .returning();
    expect(row!.userId).toBe(userId);
    expect(row!.teamId).toBeNull();
  });

  it("accepts a team-owned upstream (team_id set, user_id null) — existing behavior", async () => {
    const [row] = await db.insert(upstreamAccounts).values({
      orgId, teamId, name: "team-upstream", platform: "openai", type: "api_key",
    }).returning();
    expect(row!.userId).toBeNull();
    expect(row!.teamId).toBe(teamId);
  });

  it("accepts an org-pooled upstream (both user_id and team_id null)", async () => {
    const [row] = await db.insert(upstreamAccounts).values({
      orgId, name: "pooled", platform: "openai", type: "api_key",
    }).returning();
    expect(row!.userId).toBeNull();
    expect(row!.teamId).toBeNull();
  });
});

// ── Task 2: api_keys.routing_policy ───────────────────────────────────────────

describe("api_keys routing_policy column", () => {
  it("api_keys default routing_policy is 'pool'", async () => {
    const [k] = await db.insert(apiKeys).values({
      userId, orgId, keyHash: "h1", keyPrefix: "ak_p1", name: "k",
    }).returning();
    expect(k!.routingPolicy).toBe("pool");
  });

  it("api_keys CHECK rejects non-pool policy with a group_id", async () => {
    // expect a DB CHECK violation on api_keys_routing_policy_group_mutex
    let err: unknown;
    try {
      await db.insert(apiKeys).values({
        userId, orgId, groupId, keyHash: "h2", keyPrefix: "ak_p2", name: "k", routingPolicy: "own",
      });
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect((err as { constraint?: string }).constraint ?? (err as any).cause?.constraint).toBe("api_keys_routing_policy_group_mutex");
  });

  it("api_keys CHECK rejects an unknown routing_policy value", async () => {
    let err: unknown;
    try {
      await db.insert(apiKeys).values({
        userId, orgId, keyHash: "h3", keyPrefix: "ak_p3", name: "k", routingPolicy: "nonsense" as never,
      });
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect((err as { constraint?: string }).constraint ?? (err as any).cause?.constraint).toBe("api_keys_routing_policy_values");
  });

  it("accepts a non-pool policy when no group_id is set", async () => {
    const [k] = await db.insert(apiKeys).values({
      userId, orgId, keyHash: "hpos", keyPrefix: "ak_pos", name: "k", routingPolicy: "own",
    }).returning();
    expect(k!.routingPolicy).toBe("own");
    expect(k!.groupId).toBeNull();
  });
});
