// apps/api/tests/integration/migrations/0013.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { setupTestDb, type TestDb } from "../../factories/db.js";

// Migration 0013 adds the multi-source ingest Phase 1 schema:
//   * 5 new tables: devices, device_enrollment_tokens, device_api_keys,
//     client_sessions, client_events
//   * 2 ALTERs: usage_logs.device_id, request_bodies.{device_id, source}
//   * client_events is RANGE-partitioned by ingested_at MONTHLY with 4
//     initial partitions (2026-05 through 2026-08). PK and UNIQUE include
//     ingested_at because postgres requires partition keys in every
//     uniqueness constraint on a partitioned table.

describe("migration 0013 multi-source ingest phase 1", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await setupTestDb();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("creates all 5 new tables", async () => {
    const rows = await testDb.db.execute<{ table_name: string }>(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'devices',
          'device_enrollment_tokens',
          'device_api_keys',
          'client_sessions',
          'client_events'
        )
      ORDER BY table_name
    `);
    expect(rows.rows.map((r) => r.table_name)).toEqual([
      "client_events",
      "client_sessions",
      "device_api_keys",
      "device_enrollment_tokens",
      "devices",
    ]);
  });

  it("client_events is a partitioned table (RANGE by ingested_at)", async () => {
    const rows = await testDb.db.execute<{
      partition_strategy: string;
      partition_key: string;
    }>(sql`
      SELECT
        pt.partstrat AS partition_strategy,
        pg_get_partkeydef(c.oid) AS partition_key
      FROM pg_class c
      JOIN pg_partitioned_table pt ON pt.partrelid = c.oid
      WHERE c.relname = 'client_events'
    `);
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.partition_strategy).toBe("r"); // RANGE
    expect(rows.rows[0]!.partition_key).toContain("ingested_at");
  });

  it("creates 4 initial monthly partitions for 2026-05 through 2026-08", async () => {
    const rows = await testDb.db.execute<{ table_name: string }>(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name LIKE 'client_events_2026_%'
      ORDER BY table_name
    `);
    expect(rows.rows.map((r) => r.table_name)).toEqual([
      "client_events_2026_05",
      "client_events_2026_06",
      "client_events_2026_07",
      "client_events_2026_08",
    ]);
  });

  it("each partition inherits PK and UNIQUE constraints from parent", async () => {
    const rows = await testDb.db.execute<{
      constraint_name: string;
      constraint_type: string;
    }>(sql`
      SELECT constraint_name, constraint_type
      FROM information_schema.table_constraints
      WHERE table_name = 'client_events_2026_05'
        AND constraint_type IN ('PRIMARY KEY', 'UNIQUE')
      ORDER BY constraint_type
    `);
    const kinds = rows.rows.map((r) => r.constraint_type).sort();
    expect(kinds).toEqual(["PRIMARY KEY", "UNIQUE"]);
  });

  it("inserts into client_events route to the correct partition by ingested_at", async () => {
    // Seed minimal FK chain.
    await testDb.db.execute(sql`
      INSERT INTO organizations (id, slug, name)
      VALUES ('00000000-0000-0000-0000-000000000001', 'test-org', 'Test Org')
    `);
    await testDb.db.execute(sql`
      INSERT INTO users (id, email)
      VALUES ('00000000-0000-0000-0000-000000000002', 'test@example.com')
    `);
    await testDb.db.execute(sql`
      INSERT INTO devices (id, user_id, org_id, hostname, os, agent_version)
      VALUES (
        '00000000-0000-0000-0000-000000000003',
        '00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000001',
        'test-host', 'darwin 25.3.0', '0.1.0'
      )
    `);
    await testDb.db.execute(sql`
      INSERT INTO client_sessions (
        id, device_id, user_id, org_id, source_client,
        started_at, last_event_at
      )
      VALUES (
        'sess-test-1',
        '00000000-0000-0000-0000-000000000003',
        '00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000001',
        'claude-code',
        '2026-05-18 10:00:00+00',
        '2026-05-18 10:00:00+00'
      )
    `);

    // Insert events into different months and confirm partition routing.
    await testDb.db.execute(sql`
      INSERT INTO client_events (
        org_id, device_id, session_id, event_id, event_type, timestamp, ingested_at
      )
      VALUES
        (
          '00000000-0000-0000-0000-000000000001',
          '00000000-0000-0000-0000-000000000003',
          'sess-test-1', 'evt-may-1', 'text',
          '2026-05-18 10:00:00+00',
          '2026-05-18 10:00:00+00'
        ),
        (
          '00000000-0000-0000-0000-000000000001',
          '00000000-0000-0000-0000-000000000003',
          'sess-test-1', 'evt-jun-1', 'text',
          '2026-06-15 10:00:00+00',
          '2026-06-15 10:00:00+00'
        )
    `);

    const mayRows = await testDb.db.execute<{ event_id: string }>(sql`
      SELECT event_id FROM client_events_2026_05
    `);
    const junRows = await testDb.db.execute<{ event_id: string }>(sql`
      SELECT event_id FROM client_events_2026_06
    `);
    expect(mayRows.rows.map((r) => r.event_id)).toEqual(["evt-may-1"]);
    expect(junRows.rows.map((r) => r.event_id)).toEqual(["evt-jun-1"]);

    // Parent-table SELECT sees both partitions transparently.
    const allRows = await testDb.db.execute<{ event_id: string }>(sql`
      SELECT event_id FROM client_events
      WHERE session_id = 'sess-test-1'
      ORDER BY ingested_at
    `);
    expect(allRows.rows.map((r) => r.event_id)).toEqual([
      "evt-may-1",
      "evt-jun-1",
    ]);
  });

  it("UNIQUE dedup_key catches in-partition duplicate retries (ingest idempotency)", async () => {
    // Same (session_id, event_id, source, ingested_at) — must be rejected.
    await expect(
      testDb.db.execute(sql`
        INSERT INTO client_events (
          org_id, device_id, session_id, event_id, event_type, timestamp, ingested_at
        )
        VALUES (
          '00000000-0000-0000-0000-000000000001',
          '00000000-0000-0000-0000-000000000003',
          'sess-test-1', 'evt-may-1', 'text',
          '2026-05-18 10:00:00+00',
          '2026-05-18 10:00:00+00'
        )
      `),
    ).rejects.toThrow(/client_events_dedup_key|duplicate key/i);
  });

  it("DROP PARTITION removes a month's data cleanly (retention path)", async () => {
    await testDb.db.execute(sql`DROP TABLE "client_events_2026_05"`);

    const partitions = await testDb.db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_name LIKE 'client_events_2026_%'
      ORDER BY table_name
    `);
    expect(partitions.rows.map((r) => r.table_name)).toEqual([
      "client_events_2026_06",
      "client_events_2026_07",
      "client_events_2026_08",
    ]);

    // Parent table still sees the june row.
    const remaining = await testDb.db.execute<{ event_id: string }>(sql`
      SELECT event_id FROM client_events ORDER BY ingested_at
    `);
    expect(remaining.rows.map((r) => r.event_id)).toEqual(["evt-jun-1"]);
  });

  it("ALTER usage_logs.device_id is nullable and references devices", async () => {
    const cols = await testDb.db.execute<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'usage_logs' AND column_name = 'device_id'
    `);
    expect(cols.rows.length).toBe(1);
    expect(cols.rows[0]!.data_type).toBe("uuid");
    expect(cols.rows[0]!.is_nullable).toBe("YES");
  });

  it("ALTER request_bodies.device_id (nullable) + source (NOT NULL default 'gateway')", async () => {
    const cols = await testDb.db.execute<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(sql`
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'request_bodies'
        AND column_name IN ('device_id', 'source')
      ORDER BY column_name
    `);
    expect(cols.rows.length).toBe(2);
    const byCol = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));
    expect(byCol["device_id"]!.is_nullable).toBe("YES");
    expect(byCol["source"]!.is_nullable).toBe("NO");
    expect(byCol["source"]!.column_default).toContain("'gateway'");
  });
});
