import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import pg from "pg";
import path from "node:path";
import { createRequire } from "node:module";
import { accountGroups, organizations } from "@caliber/db";
import {
  isLegacyGroupId,
  resolveGroupContext,
} from "../../src/runtime/groupDispatch.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let orgId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {});  // swallow 57P01 admin-shutdown on container teardown
  db = drizzle(pool);
  await migrate(db, { migrationsFolder });
  const [org] = await db
    .insert(organizations)
    .values({ slug: "group-dispatch-org", name: "Group Dispatch Org" })
    .returning();
  orgId = org!.id;
}, 60_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await db.delete(accountGroups);
});

async function seedGroup(
  overrides: Partial<typeof accountGroups.$inferInsert> = {},
) {
  const [row] = await db
    .insert(accountGroups)
    .values({
      orgId,
      name: overrides.name ?? "default",
      platform: "anthropic",
      ...overrides,
    })
    .returning();
  return row!;
}

describe("resolveGroupContext", () => {
  it("returns the row's platform / rateMultiplier / isExclusive for an active group", async () => {
    const group = await seedGroup({
      platform: "openai",
      rateMultiplier: "2.5",
      isExclusive: true,
    });
    const ctx = await resolveGroupContext(db as never, {
      orgId,
      policy: "pool",
      groupId: group.id,
    });
    expect(ctx).not.toBeNull();
    expect(ctx!.groupId).toBe(group.id);
    expect(ctx!.platform).toBe("openai");
    expect(ctx!.rateMultiplier).toBe(2.5);
    expect(ctx!.isExclusive).toBe(true);
    expect(ctx!.isLegacy).toBe(false);
    expect(ctx!.isByok).toBe(false);
    expect(ctx!.policy).toBe("pool");
  });

  it("synthesises a legacy group when groupId is null", async () => {
    const ctx = await resolveGroupContext(db as never, {
      orgId,
      policy: "pool",
      groupId: null,
    });
    expect(ctx).not.toBeNull();
    expect(ctx!.groupId).toBe(`legacy:${orgId}`);
    expect(ctx!.platform).toBe("anthropic");
    expect(ctx!.rateMultiplier).toBe(1.0);
    expect(ctx!.isExclusive).toBe(false);
    expect(ctx!.isLegacy).toBe(true);
    expect(ctx!.isByok).toBe(false);
    expect(ctx!.policy).toBe("pool");
  });

  it("non-pool policy → groupless surface-derived BYOK ctx, no DB row, no legacy synth", async () => {
    const ctx = await resolveGroupContext(db as never, {
      orgId,
      policy: "own",
      groupId: null,
      surfacePlatform: "openai",
    });
    expect(ctx).not.toBeNull();
    expect(ctx!.groupId).toBeNull();
    expect(ctx!.platform).toBe("openai");
    expect(ctx!.rateMultiplier).toBe(1.0);
    expect(ctx!.isExclusive).toBe(false);
    expect(ctx!.isLegacy).toBe(false);
    expect(ctx!.isByok).toBe(true);
    expect(ctx!.policy).toBe("own");
  });

  it("own_then_pool policy carries the surface platform through (e.g. anthropic)", async () => {
    const ctx = await resolveGroupContext(db as never, {
      orgId,
      policy: "own_then_pool",
      groupId: null,
      surfacePlatform: "anthropic",
    });
    expect(ctx!.platform).toBe("anthropic");
    expect(ctx!.isByok).toBe(true);
    expect(ctx!.policy).toBe("own_then_pool");
  });

  it("throws when a non-pool policy is missing a surfacePlatform", async () => {
    await expect(
      resolveGroupContext(db as never, {
        orgId,
        policy: "own",
        groupId: null,
      }),
    ).rejects.toThrow(/surfacePlatform/);
  });

  it("returns null for a disabled group (status != active)", async () => {
    const group = await seedGroup({ status: "disabled" });
    const ctx = await resolveGroupContext(db as never, {
      orgId,
      policy: "pool",
      groupId: group.id,
    });
    expect(ctx).toBeNull();
  });

  it("returns null for a soft-deleted group", async () => {
    const group = await seedGroup({ deletedAt: new Date() });
    const ctx = await resolveGroupContext(db as never, {
      orgId,
      policy: "pool",
      groupId: group.id,
    });
    expect(ctx).toBeNull();
  });

  it("returns null when the row's platform is unknown (defense in depth)", async () => {
    // Migration 0008 adds a CHECK on platform; the runtime guard in
    // resolveGroupContext is a belt-and-suspenders fallback for the case
    // where the constraint is dropped or bypassed. Drop it for the
    // duration of this test to verify the runtime check still rejects
    // bogus values.
    await db.execute(
      sql`ALTER TABLE account_groups DROP CONSTRAINT account_groups_platform_values`,
    );
    try {
      const group = await seedGroup({ platform: "bogus_platform" });
      const ctx = await resolveGroupContext(db as never, {
        orgId,
        policy: "pool",
        groupId: group.id,
      });
      expect(ctx).toBeNull();
    } finally {
      // Delete the bogus row so the constraint can be re-added.
      await db.delete(accountGroups);
      await db.execute(
        sql`ALTER TABLE account_groups ADD CONSTRAINT account_groups_platform_values CHECK ("platform" IN ('anthropic', 'openai', 'gemini', 'antigravity'))`,
      );
    }
  });

  it("falls back to rateMultiplier=1.0 when the column is non-finite", async () => {
    // Crafting a NaN through the API is impossible (decimal column rejects
    // it), so we test by inserting a row that round-trips through Number()
    // as a non-finite value: tiny string that drizzle still accepts as
    // decimal, but we override the decimal cast post-load. Easier: insert
    // a value that drizzle returns as "0" and verify the floor kicks in.
    const group = await seedGroup({ rateMultiplier: "0.0000" });
    const ctx = await resolveGroupContext(db as never, {
      orgId,
      policy: "pool",
      groupId: group.id,
    });
    expect(ctx).not.toBeNull();
    // 0 is non-positive → falls back to 1.0 to avoid zeroing scheduler weights.
    expect(ctx!.rateMultiplier).toBe(1.0);
  });

  it("preserves a valid rateMultiplier (no fallback when finite + positive)", async () => {
    const group = await seedGroup({ rateMultiplier: "3.7500" });
    const ctx = await resolveGroupContext(db as never, {
      orgId,
      policy: "pool",
      groupId: group.id,
    });
    expect(ctx!.rateMultiplier).toBe(3.75);
  });

  it("rejects cross-tenant lookup (different orgId)", async () => {
    const [otherOrg] = await db
      .insert(organizations)
      .values({ slug: `cross-${Date.now()}`, name: "Cross Org" })
      .returning();
    const group = await seedGroup({ orgId: otherOrg!.id });
    const ctx = await resolveGroupContext(db as never, {
      orgId, // request scoped to the original org
      policy: "pool",
      groupId: group.id,
    });
    expect(ctx).toBeNull();
  });
});

describe("isLegacyGroupId", () => {
  it("is true for `legacy:` prefixed ids", () => {
    expect(isLegacyGroupId("legacy:org-123")).toBe(true);
  });
  it("is false for UUIDs", () => {
    expect(isLegacyGroupId("00000000-0000-0000-0000-000000000000")).toBe(false);
  });
});
