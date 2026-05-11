/**
 * Integration test for the GDPR expire cron (Plan 4B Part 10, Task 10.3).
 *
 * Stands up a real Postgres testcontainer. Seeds gdpr_delete_requests rows with
 * various requested_at timestamps and verification states, then verifies:
 *
 *   1. Request older than 30 days without approval/rejection → auto-rejected
 *   2. Request younger than 30 days → unchanged
 *   3. Already-approved or already-rejected request → unchanged
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
import { sql, eq } from "drizzle-orm";
import {
  organizations,
  users,
  gdprDeleteRequests,
  type Database,
} from "@caliber/db";
import { expireStaleGdprRequests } from "../../src/workers/gdprExpire.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

// ── Container + shared fixtures ───────────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

let orgId: string;
let userId: string;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  db = drizzle(pool) as unknown as Database;
  await migrate(db, { migrationsFolder });

  const [org] = await db
    .insert(organizations)
    .values({ slug: "gdpr-expire-test-org", name: "GDPR Expire Test Org" })
    .returning();
  orgId = org!.id;

  const [user] = await db
    .insert(users)
    .values({ email: "gdpr-expire-test@example.com" })
    .returning();
  userId = user!.id;
}, 60_000);

afterAll(async () => {
  await pool.end();
  await pgContainer.stop();
});

// ── Per-test cleanup ──────────────────────────────────────────────────────────

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE TABLE gdpr_delete_requests RESTART IDENTITY CASCADE`,
  );
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function countPending(): Promise<number> {
  const rows = await db.execute(
    sql`SELECT COUNT(*)::int AS cnt FROM gdpr_delete_requests WHERE approved_at IS NULL AND rejected_at IS NULL`,
  );
  return (rows.rows[0] as { cnt: number }).cnt;
}

async function countAutoRejected(): Promise<number> {
  const rows = await db.execute(
    sql`SELECT COUNT(*)::int AS cnt FROM gdpr_delete_requests WHERE rejected_reason LIKE 'auto-rejected%'`,
  );
  return (rows.rows[0] as { cnt: number }).cnt;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("expireStaleGdprRequests", () => {
  it("1. request older than 30 days without approval/rejection → auto-rejected", async () => {
    const now = new Date();
    const thirtyOneDaysAgo = new Date(
      now.getTime() - 31 * 24 * 60 * 60 * 1000,
    );

    const [req] = await db
      .insert(gdprDeleteRequests)
      .values({
        orgId,
        userId,
        scope: "bodies",
        requestedAt: thirtyOneDaysAgo,
      })
      .returning({ id: gdprDeleteRequests.id });
    const requestId = req!.id;

    expect(await countPending()).toBe(1);
    expect(await countAutoRejected()).toBe(0);

    const result = await expireStaleGdprRequests({ db, now: () => now });

    expect(result.autoRejected).toBe(1);
    expect(await countPending()).toBe(0);
    expect(await countAutoRejected()).toBe(1);

    // Verify rejectedAt and rejectedReason were set
    const [updated] = await db
      .select({
        rejectedAt: gdprDeleteRequests.rejectedAt,
        rejectedReason: gdprDeleteRequests.rejectedReason,
      })
      .from(gdprDeleteRequests)
      .where(eq(gdprDeleteRequests.id, requestId));

    expect(updated!.rejectedAt).not.toBeNull();
    expect(updated!.rejectedReason).toContain("auto-rejected");
    expect(updated!.rejectedReason).toContain("30 days");
  });

  it("2. request younger than 30 days → unchanged", async () => {
    const now = new Date();
    const twentyNineDaysAgo = new Date(
      now.getTime() - 29 * 24 * 60 * 60 * 1000,
    );

    await db.insert(gdprDeleteRequests).values({
      orgId,
      userId,
      scope: "bodies",
      requestedAt: twentyNineDaysAgo,
    });

    expect(await countPending()).toBe(1);

    const result = await expireStaleGdprRequests({ db, now: () => now });

    expect(result.autoRejected).toBe(0);
    expect(await countPending()).toBe(1);

    // Verify request is still pending (not rejected)
    const [unchanged] = await db
      .select({
        rejectedAt: gdprDeleteRequests.rejectedAt,
      })
      .from(gdprDeleteRequests);

    expect(unchanged!.rejectedAt).toBeNull();
  });

  it("3. already-approved request → unchanged", async () => {
    const now = new Date();
    const thirtyOneDaysAgo = new Date(
      now.getTime() - 31 * 24 * 60 * 60 * 1000,
    );

    await db.insert(gdprDeleteRequests).values({
      orgId,
      userId,
      scope: "bodies",
      requestedAt: thirtyOneDaysAgo,
      approvedAt: now,
      approvedByUserId: userId,
    });

    expect(await countPending()).toBe(0); // Not pending (approvedAt is set)

    const result = await expireStaleGdprRequests({ db, now: () => now });

    expect(result.autoRejected).toBe(0);

    // Verify request still has approvedAt and no rejectedAt
    const [unchanged] = await db
      .select({
        approvedAt: gdprDeleteRequests.approvedAt,
        rejectedAt: gdprDeleteRequests.rejectedAt,
      })
      .from(gdprDeleteRequests);

    expect(unchanged!.approvedAt).not.toBeNull();
    expect(unchanged!.rejectedAt).toBeNull();
  });

  it("4. already-rejected request → unchanged", async () => {
    const now = new Date();
    const thirtyOneDaysAgo = new Date(
      now.getTime() - 31 * 24 * 60 * 60 * 1000,
    );

    const oldRejectedReason = "user changed mind";
    await db.insert(gdprDeleteRequests).values({
      orgId,
      userId,
      scope: "bodies",
      requestedAt: thirtyOneDaysAgo,
      rejectedAt: now,
      rejectedReason: oldRejectedReason,
    });

    expect(await countPending()).toBe(0); // Not pending (rejectedAt is set)

    const result = await expireStaleGdprRequests({ db, now: () => now });

    expect(result.autoRejected).toBe(0);

    // Verify rejectedReason unchanged
    const [unchanged] = await db
      .select({
        rejectedReason: gdprDeleteRequests.rejectedReason,
      })
      .from(gdprDeleteRequests);

    expect(unchanged!.rejectedReason).toBe(oldRejectedReason);
  });

  it("5. mixed batch: only stale pending requests auto-rejected", async () => {
    const now = new Date();
    const thirtyOneDaysAgo = new Date(
      now.getTime() - 31 * 24 * 60 * 60 * 1000,
    );
    const twentyNineDaysAgo = new Date(
      now.getTime() - 29 * 24 * 60 * 60 * 1000,
    );

    // Stale pending (should be auto-rejected)
    await db.insert(gdprDeleteRequests).values({
      orgId,
      userId,
      scope: "bodies",
      requestedAt: thirtyOneDaysAgo,
    });

    // Young pending (should not be touched)
    await db.insert(gdprDeleteRequests).values({
      orgId,
      userId,
      scope: "bodies",
      requestedAt: twentyNineDaysAgo,
    });

    // Stale approved (should not be touched)
    await db.insert(gdprDeleteRequests).values({
      orgId,
      userId,
      scope: "bodies",
      requestedAt: thirtyOneDaysAgo,
      approvedAt: now,
      approvedByUserId: userId,
    });

    // Stale rejected (should not be touched)
    await db.insert(gdprDeleteRequests).values({
      orgId,
      userId,
      scope: "bodies",
      requestedAt: thirtyOneDaysAgo,
      rejectedAt: now,
      rejectedReason: "existing rejection",
    });

    const result = await expireStaleGdprRequests({ db, now: () => now });

    expect(result.autoRejected).toBe(1);

    // Verify counts: 1 auto-rejected, 3 untouched
    expect(await countAutoRejected()).toBe(1);

    const all = await db.select().from(gdprDeleteRequests);
    expect(all).toHaveLength(4);
  });
});
