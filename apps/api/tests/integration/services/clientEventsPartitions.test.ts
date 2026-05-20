import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { setupTestDb, type TestDb } from "../../factories/db.js";
import {
  computeUpcomingPartitions,
  ensureClientEventsPartitions,
} from "../../../src/services/clientEventsPartitions.js";

let testDb: TestDb;

async function listClientEventsPartitions(): Promise<string[]> {
  const rows = await testDb.db.execute<{ table_name: string }>(sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name LIKE 'client_events_%'
    ORDER BY table_name
  `);
  return rows.rows.map((r) => r.table_name);
}

describe("computeUpcomingPartitions (pure)", () => {
  it("returns current month + N lookahead months in UTC", () => {
    const now = new Date("2026-07-15T12:34:56Z");
    const specs = computeUpcomingPartitions(now, 3);
    expect(specs.map((s) => s.partitionName)).toEqual([
      "client_events_2026_07",
      "client_events_2026_08",
      "client_events_2026_09",
      "client_events_2026_10",
    ]);
    expect(specs[0]!.rangeStart).toBe("2026-07-01T00:00:00.000Z");
    expect(specs[0]!.rangeEnd).toBe("2026-08-01T00:00:00.000Z");
    expect(specs[3]!.rangeStart).toBe("2026-10-01T00:00:00.000Z");
    expect(specs[3]!.rangeEnd).toBe("2026-11-01T00:00:00.000Z");
  });

  it("wraps the year boundary cleanly", () => {
    const now = new Date("2026-11-15T00:00:00Z");
    const specs = computeUpcomingPartitions(now, 3);
    expect(specs.map((s) => s.partitionName)).toEqual([
      "client_events_2026_11",
      "client_events_2026_12",
      "client_events_2027_01",
      "client_events_2027_02",
    ]);
    expect(specs[2]!.rangeStart).toBe("2027-01-01T00:00:00.000Z");
    expect(specs[2]!.rangeEnd).toBe("2027-02-01T00:00:00.000Z");
  });

  it("lookahead 0 returns just the current month", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const specs = computeUpcomingPartitions(now, 0);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.partitionName).toBe("client_events_2026_06");
  });
});

describe("ensureClientEventsPartitions (integration)", () => {
  beforeAll(async () => {
    testDb = await setupTestDb();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    // Reset to the 0013 baseline (2026-05 through 2026-08 exist; later months
    // should be created by the roll-forward).
    const partitions = await listClientEventsPartitions();
    for (const p of partitions) {
      if (
        ![
          "client_events_2026_05",
          "client_events_2026_06",
          "client_events_2026_07",
          "client_events_2026_08",
        ].includes(p)
      ) {
        await testDb.db.execute(sql.raw(`DROP TABLE "${p}"`));
      }
    }
  });

  it("creates missing partitions for current + lookahead months", async () => {
    // Simulate a now-date in 2026-08 with lookahead=3 → should ensure
    // 2026-08..2026-11. 2026-08 already exists from migration; 2026-09/10/11
    // must be created.
    const result = await ensureClientEventsPartitions({
      db: testDb.db,
      now: () => new Date("2026-08-15T00:00:00Z"),
      lookaheadMonths: 3,
    });

    expect(result.ensured).toEqual([
      "client_events_2026_08",
      "client_events_2026_09",
      "client_events_2026_10",
      "client_events_2026_11",
    ]);
    expect(result.created.sort()).toEqual([
      "client_events_2026_09",
      "client_events_2026_10",
      "client_events_2026_11",
    ]);

    const after = await listClientEventsPartitions();
    expect(after).toEqual([
      "client_events_2026_05",
      "client_events_2026_06",
      "client_events_2026_07",
      "client_events_2026_08",
      "client_events_2026_09",
      "client_events_2026_10",
      "client_events_2026_11",
    ]);
  });

  it("is idempotent: running twice creates nothing the second time", async () => {
    await ensureClientEventsPartitions({
      db: testDb.db,
      now: () => new Date("2026-08-15T00:00:00Z"),
      lookaheadMonths: 3,
    });

    const second = await ensureClientEventsPartitions({
      db: testDb.db,
      now: () => new Date("2026-08-15T00:00:00Z"),
      lookaheadMonths: 3,
    });

    expect(second.created).toEqual([]);
    expect(second.ensured).toHaveLength(4);
  });

  it("new partition routes inserts correctly", async () => {
    await ensureClientEventsPartitions({
      db: testDb.db,
      now: () => new Date("2026-08-15T00:00:00Z"),
      lookaheadMonths: 3,
    });

    // Seed FK chain.
    await testDb.db.execute(sql`
      INSERT INTO organizations (id, slug, name)
      VALUES ('00000000-0000-0000-0000-00000000aaaa', 'roll-org', 'Roll Org')
    `);
    await testDb.db.execute(sql`
      INSERT INTO users (id, email)
      VALUES ('00000000-0000-0000-0000-00000000bbbb', 'roll@example.com')
    `);
    await testDb.db.execute(sql`
      INSERT INTO devices (id, user_id, org_id, hostname, os, agent_version)
      VALUES (
        '00000000-0000-0000-0000-00000000cccc',
        '00000000-0000-0000-0000-00000000bbbb',
        '00000000-0000-0000-0000-00000000aaaa',
        'r', 'darwin', '0.1.0'
      )
    `);
    await testDb.db.execute(sql`
      INSERT INTO client_sessions (
        id, device_id, user_id, org_id, source_client,
        started_at, last_event_at
      ) VALUES (
        'roll-sess',
        '00000000-0000-0000-0000-00000000cccc',
        '00000000-0000-0000-0000-00000000bbbb',
        '00000000-0000-0000-0000-00000000aaaa',
        'claude-code',
        '2026-11-01 00:00:00+00', '2026-11-01 00:00:00+00'
      )
    `);

    // Insert an event whose ingested_at lands in 2026-11 — the newly-created
    // partition must accept it.
    await testDb.db.execute(sql`
      INSERT INTO client_events (
        org_id, device_id, session_id, event_id, event_type, timestamp,
        ingested_at, source
      ) VALUES (
        '00000000-0000-0000-0000-00000000aaaa',
        '00000000-0000-0000-0000-00000000cccc',
        'roll-sess', 'roll-evt-1', 'text',
        '2026-11-15 10:00:00+00', '2026-11-15 10:00:00+00',
        'transcript'
      )
    `);

    const rows = await testDb.db.execute<{ event_id: string }>(sql`
      SELECT event_id FROM client_events_2026_11
    `);
    expect(rows.rows.map((r) => r.event_id)).toEqual(["roll-evt-1"]);
  });
});
