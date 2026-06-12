import { sql } from "drizzle-orm";
import type { Database } from "@caliber/db";
import type { Redis } from "ioredis";

// Child-first not needed — CASCADE handles the RESTRICT FK graph (usage_logs →
// users/api_keys/upstream_accounts/organizations; request_bodies/facets →
// usage_logs; credential_vault → upstream_accounts; organization_members, etc.).
// Table names verified against packages/db/src/schema/*.ts (the first arg to
// pgTable("...")). NOTE: the membership table is `organization_members`, not
// `memberships` (packages/db/src/schema/membership.ts).
const DATA_TABLES = [
  "usage_logs", "request_bodies", "request_body_facets", "idempotency_records",
  "credential_vault", "upstream_accounts", "api_keys",
  "account_group_members", "account_groups",
  "organization_members", "users", "organizations",
];

export async function truncateData(db: Database): Promise<void> {
  await db.execute(sql.raw(`TRUNCATE ${DATA_TABLES.join(", ")} RESTART IDENTITY CASCADE`));
}

/** Clear the whole `caliber:gw*` keyspace via a RAW (un-prefixed) client. */
export async function clearGatewayKeyspace(raw: Redis): Promise<void> {
  let cursor = "0";
  do {
    const [next, batch] = await raw.scan(cursor, "MATCH", "caliber:gw*", "COUNT", 500);
    cursor = next;
    if (batch.length > 0) await raw.unlink(...batch);
  } while (cursor !== "0");
}
