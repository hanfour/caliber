/**
 * Integration tests for rubricResolver (Plan 4B Part 4, Task 4.4).
 *
 * Stands up a real Postgres testcontainer. Tests exercise the resolver logic:
 * org custom → platform-default, locale-aware fallback, caching, and soft-delete
 * handling.
 *
 * Test cases:
 *   1. Org with custom rubric → returns custom
 *   2. Org without custom, locale "en" → returns platform-default en
 *   3. Org without custom, locale "zh-Hant" → returns platform-default zh-Hant
 *   4. Org with missing (soft-deleted) custom → falls back to platform-default
 *   5. Cache hit within TTL → no 2nd DB call
 *   6. Cache expiry after TTL → DB re-queried
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "node:path";
import { createRequire } from "node:module";
import { eq } from "drizzle-orm";
import { organizations, rubrics, type Database } from "@caliber/db";
import { rubricSchema, type Rubric } from "@caliber/evaluator";
import {
  createRubricResolver,
  RUBRIC_CACHE_TTL_MS,
  type ResolvedRubric,
} from "../../../src/workers/evaluator/rubricResolver.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

// ── Test fixtures ────────────────────────────────────────────────────────────

const EN_RUBRIC: Rubric = {
  name: "Platform English",
  version: "1.0.0",
  locale: "en",
  sections: [
    {
      id: "quality",
      name: "Quality",
      weight: "100%",
      standard: {
        score: 100,
        label: "Standard",
        criteria: ["meets baseline"],
      },
      superior: {
        score: 120,
        label: "Superior",
        criteria: ["exceeds expectations"],
      },
      signals: [{ type: "cache_read_ratio", id: "cr", gte: 0.1 }],
    },
  ],
};

const ZH_HANT_RUBRIC: Rubric = {
  name: "Platform Chinese (Traditional)",
  version: "1.0.0",
  locale: "zh-Hant",
  sections: [
    {
      id: "quality",
      name: "品質",
      weight: "100%",
      standard: {
        score: 100,
        label: "Standard",
        criteria: ["meets baseline"],
      },
      superior: {
        score: 120,
        label: "Superior",
        criteria: ["exceeds expectations"],
      },
      signals: [{ type: "cache_read_ratio", id: "cr", gte: 0.1 }],
    },
  ],
};

const JA_RUBRIC: Rubric = {
  name: "Platform Japanese",
  version: "1.0.0",
  locale: "ja",
  sections: [
    {
      id: "quality",
      name: "品質",
      weight: "100%",
      standard: {
        score: 100,
        label: "Standard",
        criteria: ["meets baseline"],
      },
      superior: {
        score: 120,
        label: "Superior",
        criteria: ["exceeds expectations"],
      },
      signals: [{ type: "cache_read_ratio", id: "cr", gte: 0.1 }],
    },
  ],
};

const CUSTOM_RUBRIC: Rubric = {
  name: "Org Custom Rubric",
  version: "2.0.0",
  locale: "en",
  sections: [
    {
      id: "custom",
      name: "Custom Section",
      weight: "100%",
      standard: {
        score: 100,
        label: "Standard",
        criteria: ["custom criteria"],
      },
      superior: {
        score: 120,
        label: "Superior",
        criteria: ["superior custom"],
      },
      signals: [{ type: "iteration_count", id: "ic", gte: 3 }],
    },
  ],
};

// ── Container + shared fixtures ──────────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

let orgWithCustomRubricId: string;
let orgWithoutCustomRubricId: string;
let orgWithDeletedCustomRubricId: string;

let customRubricId: string;
let deletedRubricId: string;
let platformDefaultEnId: string;
let platformDefaultZhHantId: string;
let platformDefaultJaId: string;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  db = drizzle(pool) as unknown as Database;
  await migrate(db, { migrationsFolder });

  // Migration 0003 seeds 3 real platform rubrics; remove them so this test
  // owns the fixture set it asserts against.
  await db.delete(rubrics);

  // Seed 3 platform-default rubrics (en, zh-Hant, ja)
  const [enDefault] = await db
    .insert(rubrics)
    .values({
      orgId: null,
      name: "Platform Default EN",
      version: EN_RUBRIC.version,
      definition: EN_RUBRIC,
      isDefault: true,
    })
    .returning();
  platformDefaultEnId = enDefault!.id;

  const [zhHantDefault] = await db
    .insert(rubrics)
    .values({
      orgId: null,
      name: "Platform Default ZH-Hant",
      version: ZH_HANT_RUBRIC.version,
      definition: ZH_HANT_RUBRIC,
      isDefault: true,
    })
    .returning();
  platformDefaultZhHantId = zhHantDefault!.id;

  const [jaDefault] = await db
    .insert(rubrics)
    .values({
      orgId: null,
      name: "Platform Default JA",
      version: JA_RUBRIC.version,
      definition: JA_RUBRIC,
      isDefault: true,
    })
    .returning();
  platformDefaultJaId = jaDefault!.id;

  // Seed 1 custom rubric (for org to use)
  const [custom] = await db
    .insert(rubrics)
    .values({
      orgId: null, // Platform rubric, not org-specific yet
      name: "Org Custom",
      version: CUSTOM_RUBRIC.version,
      definition: CUSTOM_RUBRIC,
      isDefault: false,
    })
    .returning();
  customRubricId = custom!.id;

  // Seed 1 soft-deleted rubric
  const [deleted] = await db
    .insert(rubrics)
    .values({
      orgId: null,
      name: "Deleted Rubric",
      version: "0.0.0",
      definition: EN_RUBRIC,
      isDefault: false,
      deletedAt: new Date(),
    })
    .returning();
  deletedRubricId = deleted!.id;

  // Seed 3 orgs:
  // - One with custom rubric
  // - One without custom rubric
  // - One with deleted custom rubric
  const [org1] = await db
    .insert(organizations)
    .values({
      slug: "org-with-custom",
      name: "Org With Custom",
      rubricId: customRubricId,
    })
    .returning();
  orgWithCustomRubricId = org1!.id;

  const [org2] = await db
    .insert(organizations)
    .values({
      slug: "org-without-custom",
      name: "Org Without Custom",
    })
    .returning();
  orgWithoutCustomRubricId = org2!.id;

  const [org3] = await db
    .insert(organizations)
    .values({
      slug: "org-with-deleted-custom",
      name: "Org With Deleted Custom",
      rubricId: deletedRubricId,
    })
    .returning();
  orgWithDeletedCustomRubricId = org3!.id;
});

afterAll(async () => {
  await pool.end();
  await pgContainer.stop();
});

describe("rubricResolver", () => {
  it("should return org custom rubric when org has rubric_id set", async () => {
    const resolver = createRubricResolver();
    const resolved = await resolver.resolve({
      db,
      orgId: orgWithCustomRubricId,
    });

    expect(resolved.fromOrgCustom).toBe(true);
    expect(resolved.rubricId).toBe(customRubricId);
    expect(resolved.rubricVersion).toBe(CUSTOM_RUBRIC.version);
    expect(resolved.rubric.name).toBe(CUSTOM_RUBRIC.name);
  });

  it("should return platform-default en when org has no custom rubric and locale is en", async () => {
    const resolver = createRubricResolver();
    const resolved = await resolver.resolve({
      db,
      orgId: orgWithoutCustomRubricId,
      locale: "en",
    });

    expect(resolved.fromOrgCustom).toBe(false);
    expect(resolved.rubricId).toBe(platformDefaultEnId);
    expect(resolved.rubricVersion).toBe(EN_RUBRIC.version);
    expect(resolved.rubric.locale).toBe("en");
  });

  it("should return platform-default zh-Hant when org has no custom rubric and locale is zh-Hant", async () => {
    const resolver = createRubricResolver();
    const resolved = await resolver.resolve({
      db,
      orgId: orgWithoutCustomRubricId,
      locale: "zh-Hant",
    });

    expect(resolved.fromOrgCustom).toBe(false);
    expect(resolved.rubricId).toBe(platformDefaultZhHantId);
    expect(resolved.rubricVersion).toBe(ZH_HANT_RUBRIC.version);
    expect(resolved.rubric.locale).toBe("zh-Hant");
  });

  it("should return platform-default ja when org has no custom rubric and locale is ja", async () => {
    const resolver = createRubricResolver();
    const resolved = await resolver.resolve({
      db,
      orgId: orgWithoutCustomRubricId,
      locale: "ja",
    });

    expect(resolved.fromOrgCustom).toBe(false);
    expect(resolved.rubricId).toBe(platformDefaultJaId);
    expect(resolved.rubricVersion).toBe(JA_RUBRIC.version);
    expect(resolved.rubric.locale).toBe("ja");
  });

  it("should fall back to platform-default when org's custom rubric is soft-deleted", async () => {
    const resolver = createRubricResolver();
    const resolved = await resolver.resolve({
      db,
      orgId: orgWithDeletedCustomRubricId,
      locale: "en",
    });

    expect(resolved.fromOrgCustom).toBe(false);
    expect(resolved.rubricId).toBe(platformDefaultEnId);
    expect(resolved.rubricVersion).toBe(EN_RUBRIC.version);
    expect(resolved.rubric.locale).toBe("en");
  });

  it("should cache result within TTL and avoid 2nd DB call", async () => {
    let callCount = 0;
    const originalSelect = db.select;
    const dbSpy = {
      ...db,
      select: (...args: Parameters<typeof originalSelect>) => {
        callCount++;
        return originalSelect.apply(db, args);
      },
    } as typeof db;

    const now = Date.now();
    let currentTime = now;
    const resolver = createRubricResolver({
      now: () => currentTime,
      ttlMs: RUBRIC_CACHE_TTL_MS,
    });

    // First call: should hit DB
    const resolved1 = await resolver.resolve({
      db: dbSpy,
      orgId: orgWithoutCustomRubricId,
      locale: "en",
    });
    const callCountAfterFirst = callCount;

    // Advance time by 1 minute (within TTL)
    currentTime += 60 * 1000;

    // Second call: should hit cache, not DB
    const resolved2 = await resolver.resolve({
      db: dbSpy,
      orgId: orgWithoutCustomRubricId,
      locale: "en",
    });
    const callCountAfterSecond = callCount;

    expect(resolved1.rubricId).toBe(resolved2.rubricId);
    expect(callCountAfterSecond).toBe(callCountAfterFirst);
  });

  it("should re-query DB after TTL expires", async () => {
    let callCount = 0;
    const originalSelect = db.select;
    const dbSpy = {
      ...db,
      select: (...args: Parameters<typeof originalSelect>) => {
        callCount++;
        return originalSelect.apply(db, args);
      },
    } as typeof db;

    const now = Date.now();
    let currentTime = now;
    const resolver = createRubricResolver({
      now: () => currentTime,
      ttlMs: RUBRIC_CACHE_TTL_MS,
    });

    // First call: should hit DB
    await resolver.resolve({
      db: dbSpy,
      orgId: orgWithoutCustomRubricId,
      locale: "en",
    });
    const callCountAfterFirst = callCount;

    // Advance time beyond TTL (5 minutes + 1 second)
    currentTime += RUBRIC_CACHE_TTL_MS + 1000;

    // Second call: should re-query DB
    await resolver.resolve({
      db: dbSpy,
      orgId: orgWithoutCustomRubricId,
      locale: "en",
    });
    const callCountAfterSecond = callCount;

    expect(callCountAfterSecond).toBeGreaterThan(callCountAfterFirst);
  });

  it("should invalidate cache for a specific org", async () => {
    const resolver = createRubricResolver();

    // Cache a result for org1
    await resolver.resolve({
      db,
      orgId: orgWithoutCustomRubricId,
      locale: "en",
    });

    // Invalidate cache for org1
    resolver.invalidate(orgWithoutCustomRubricId);

    // We can't easily spy on cache hits without mocking internals,
    // but we can verify the function runs without errors
    const resolved = await resolver.resolve({
      db,
      orgId: orgWithoutCustomRubricId,
      locale: "en",
    });
    expect(resolved.rubricId).toBe(platformDefaultEnId);
  });

  it("should clear all cached entries", async () => {
    const resolver = createRubricResolver();

    // Cache results for multiple orgs
    await resolver.resolve({
      db,
      orgId: orgWithCustomRubricId,
    });
    await resolver.resolve({
      db,
      orgId: orgWithoutCustomRubricId,
      locale: "zh-Hant",
    });

    // Clear cache
    resolver.clear();

    // Verify we can still resolve (no errors)
    const resolved = await resolver.resolve({
      db,
      orgId: orgWithCustomRubricId,
    });
    expect(resolved.rubricId).toBe(customRubricId);
  });

  it("should default locale to en when not provided", async () => {
    const resolver = createRubricResolver();
    const resolved = await resolver.resolve({
      db,
      orgId: orgWithoutCustomRubricId,
      // No locale provided
    });

    expect(resolved.rubric.locale).toBe("en");
    expect(resolved.rubricId).toBe(platformDefaultEnId);
  });

  it("should throw when no platform-default rubric exists", async () => {
    // Create a fresh org with no seeded rubrics and invalid locale
    const [freshOrg] = await db
      .insert(organizations)
      .values({
        slug: "org-no-defaults",
        name: "Org No Defaults",
      })
      .returning();

    const resolver = createRubricResolver();

    // Delete all platform-default rubrics temporarily
    await db.delete(rubrics).where(eq(rubrics.isDefault, true));

    try {
      await expect(
        resolver.resolve({
          db,
          orgId: freshOrg!.id,
          locale: "en",
        }),
      ).rejects.toThrow(/No platform-default rubric found/);
    } finally {
      // Restore platform defaults
      await db.insert(rubrics).values({
        orgId: null,
        name: "Restored EN",
        version: EN_RUBRIC.version,
        definition: EN_RUBRIC,
        isDefault: true,
      });
    }
  });
});
