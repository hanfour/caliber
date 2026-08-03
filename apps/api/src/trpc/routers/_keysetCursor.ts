/**
 * Keyset ("seek") pagination cursor for `(timestamp DESC, id DESC)`-ordered
 * feeds. Shared by `usage.listRequests` and `sessions.listForUser` (Task 9
 * review, Finding 3 — both procedures had the identical defect, so both are
 * fixed with the same mechanism rather than two divergent one-offs).
 *
 * ## Why a naive `lt(column, new Date(cursor))` is wrong
 *
 * node-postgres parses `timestamp(tz)` columns into a JS `Date`, which only
 * holds millisecond resolution. Postgres itself stores microsecond
 * resolution. Two rows a few hundred microseconds apart — ordinary under
 * concurrent gateway traffic hitting the same user in the same millisecond —
 * can therefore read back as the *exact same* JS `Date`.
 *
 * Once the last-seen row's timestamp has been round-tripped through a JS
 * `Date` (e.g. via `.toISOString()`), its sub-millisecond remainder is
 * gone — not rounded, floored. A predicate built from that floored value
 * (`createdAt < flooredCursor`) then silently DROPS every row whose true
 * timestamp falls in `[flooredCursor, trueBoundaryValue)`: those rows sort
 * strictly after the cursor row in the database's real (microsecond-precise)
 * order, so they belong on the next page, but they are not "less than" the
 * floored cursor either, so they never appear on any page. There is no way
 * to recover that lost precision after the fact — the fix has to avoid the
 * JS `Date` round-trip in the first place.
 *
 * ## The fix
 *
 * Never materialize the cursor's timestamp component as a JS `Date`. Carry
 * it as the raw text Postgres itself prints for the column (via `::text`,
 * which preserves full microsecond precision), and feed that text straight
 * back into a raw SQL comparison cast to `timestamptz`. The comparison then
 * happens entirely inside Postgres, at full precision, in both directions.
 *
 * A primary-key `id` tiebreak is layered on top via a row-value comparison
 * (`(ts, id) < (cursorTs, cursorId)`) for the case of two rows sharing the
 * exact same microsecond timestamp — the ordinary reason to have a keyset
 * tiebreak at all, independent of the precision issue above.
 *
 * The cursor returned to the client is an opaque base64 token; callers must
 * not construct one by hand or assume it is a bare ISO date string.
 */
import { z } from "zod";
import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

const cursorPayloadSchema = z.object({
  // Full-precision `::text` rendering of the ordering timestamp column for
  // the last row of the previous page. Never a JS `Date` / ISO string that
  // has passed through millisecond truncation.
  ts: z.string().min(1).max(64),
  // The tiebreak column's value, as a string (needed regardless of the
  // column's underlying type — e.g. usage_logs.id is a bigint, which does
  // not survive JSON.stringify without an explicit .toString()).
  id: z.string().min(1).max(200),
});

export type KeysetCursor = z.infer<typeof cursorPayloadSchema>;

/** How to cast `cursor.id` back to the tiebreak column's SQL type. */
export type KeysetIdType = "bigint" | "uuid" | "text";

export function encodeKeysetCursor(payload: KeysetCursor): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/** Throws BAD_REQUEST on any malformed or tampered cursor — never 500s. */
export function decodeKeysetCursor(raw: string): KeysetCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Malformed cursor" });
  }
  const result = cursorPayloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Malformed cursor" });
  }
  return result.data;
}

/**
 * `(tsColumn, idColumn) < (cursor.ts, cursor.id)` as a raw Postgres
 * row-value comparison — "strictly older than the last row seen", matching
 * `ORDER BY tsColumn DESC, idColumn DESC`. Both sides are cast explicitly so
 * Postgres never has to guess a bound parameter's type from context.
 */
export function keysetBeforeCursor(
  tsColumn: AnyColumn,
  idColumn: AnyColumn,
  idType: KeysetIdType,
  cursor: KeysetCursor,
): SQL {
  return sql`(${tsColumn}, ${idColumn}) < (${cursor.ts}::timestamptz, ${cursor.id}::${sql.raw(idType)})`;
}
