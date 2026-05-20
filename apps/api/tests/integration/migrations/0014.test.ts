// apps/api/tests/integration/migrations/0014.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { setupTestDb, type TestDb } from "../../factories/db.js";

// Migration 0014 wires up the evaluator's unified view:
//   * `evaluator_events` VIEW unions transcript-source events (client_events
//     joined to client_sessions) with gateway-source captures (request_bodies
//     joined to usage_logs)
//   * `request_body_facets` gains 4 transcript-only columns
//   * `evaluation_reports.source_breakdown` jsonb is added

describe("migration 0014 evaluator_events view + facet extensions", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await setupTestDb();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("creates the evaluator_events view", async () => {
    const rows = await testDb.db.execute<{ table_name: string }>(sql`
      SELECT table_name
      FROM information_schema.views
      WHERE table_schema = 'public' AND table_name = 'evaluator_events'
    `);
    expect(rows.rows.length).toBe(1);
  });

  it("evaluator_events exposes the documented columns from both branches", async () => {
    const rows = await testDb.db.execute<{ column_name: string }>(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'evaluator_events'
      ORDER BY ordinal_position
    `);
    const cols = rows.rows.map((r) => r.column_name);
    for (const required of [
      "session_id",
      "event_id",
      "event_type",
      "role",
      "timestamp",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_creation_tokens",
      "reasoning_tokens",
      "content",
      "org_id",
      "user_id",
      "device_id",
      "source_client",
      "cwd",
      "git_commit_hash",
      "git_branch",
      "event_source",
    ]) {
      expect(cols).toContain(required);
    }
  });

  it("transcript-source row surfaces correctly through the view", async () => {
    await testDb.db.execute(sql`
      INSERT INTO organizations (id, slug, name)
      VALUES ('00000000-0000-0000-0000-000000000001', 'view-org', 'View Org')
    `);
    await testDb.db.execute(sql`
      INSERT INTO users (id, email)
      VALUES ('00000000-0000-0000-0000-000000000002', 'view@example.com')
    `);
    await testDb.db.execute(sql`
      INSERT INTO devices (id, user_id, org_id, hostname, os, agent_version)
      VALUES (
        '00000000-0000-0000-0000-000000000003',
        '00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000001',
        'view-host', 'darwin', '0.1.0'
      )
    `);
    await testDb.db.execute(sql`
      INSERT INTO client_sessions (
        id, device_id, user_id, org_id, source_client, cwd,
        started_at, last_event_at
      )
      VALUES (
        'sess-view-1',
        '00000000-0000-0000-0000-000000000003',
        '00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000001',
        'claude-code', '/proj',
        '2026-05-18 10:00:00+00', '2026-05-18 10:00:00+00'
      )
    `);
    await testDb.db.execute(sql`
      INSERT INTO client_events (
        org_id, device_id, session_id, event_id, event_type, timestamp,
        ingested_at, source
      )
      VALUES (
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000003',
        'sess-view-1', 'evt-view-1', 'user_message',
        '2026-05-18 10:00:00+00', '2026-05-18 10:00:00+00',
        'transcript'
      )
    `);

    const rows = await testDb.db.execute<{
      session_id: string;
      event_id: string;
      source_client: string;
      event_source: string;
    }>(sql`
      SELECT session_id, event_id, source_client, event_source
      FROM evaluator_events
      WHERE event_id = 'evt-view-1'
    `);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.session_id).toBe("sess-view-1");
    expect(rows.rows[0]!.source_client).toBe("claude-code");
    expect(rows.rows[0]!.event_source).toBe("transcript");
  });

  it("request_body_facets has 4 new transcript-only nullable columns", async () => {
    const rows = await testDb.db.execute<{
      column_name: string;
      is_nullable: string;
    }>(sql`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'request_body_facets'
        AND column_name IN (
          'subagent_call_count',
          'reasoning_token_ratio',
          'tool_use_diversity',
          'session_topology'
        )
      ORDER BY column_name
    `);
    expect(rows.rows.map((r) => r.column_name)).toEqual([
      "reasoning_token_ratio",
      "session_topology",
      "subagent_call_count",
      "tool_use_diversity",
    ]);
    for (const row of rows.rows) {
      expect(row.is_nullable).toBe("YES");
    }
  });

  it("evaluation_reports.source_breakdown is nullable jsonb", async () => {
    const rows = await testDb.db.execute<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'evaluation_reports' AND column_name = 'source_breakdown'
    `);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.data_type).toBe("jsonb");
    expect(rows.rows[0]!.is_nullable).toBe("YES");
  });
});
