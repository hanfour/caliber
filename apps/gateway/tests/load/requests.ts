import { desc } from "drizzle-orm";
import { usageLogs } from "@caliber/db/schema";
import type { Database } from "@caliber/db";
import { drainUsageQueue } from "./drainUsageQueue.js";

/** POST /v1/messages with an api key; returns {status, json, text}. */
export async function postMessages(
  baseUrl: string, rawKey: string,
  body: Record<string, unknown> = { model: "claude-3-haiku-20240307", max_tokens: 10, messages: [{ role: "user", content: "hi" }] },
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${rawKey}`, "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* SSE or empty */ }
  return { status: res.status, json, text };
}

/**
 * Drain the usage queue to `expectedTotal` rows, then return the `account_id`
 * of the newest usage_logs row. The table is monotonic `bigserial("id")`, so
 * ordering by `id` DESC limit 1 yields the row written by the most-recent
 * request — the only signal of WHICH account the scheduler picked (there is no
 * response header exposing it). C4 (sticky) reads this after each request.
 */
async function newestAccountId(db: Database, expectedTotal: number): Promise<string | null> {
  await drainUsageQueue(db, expectedTotal);
  const rows = await db
    .select({ a: usageLogs.accountId })
    .from(usageLogs)
    .orderBy(desc(usageLogs.id))
    .limit(1);
  return rows[0]?.a ?? null;
}

/**
 * POST /v1/responses (OpenAI Responses surface) with an optional
 * `previous_response_id` (Layer 1 sticky key); drain the usage queue to
 * `expectedTotal`; return the account_id of the newest usage row.
 */
export async function postResponsesAndAccount(
  baseUrl: string, db: Database, rawKey: string, expectedTotal: number, previousResponseId?: string,
): Promise<{ status: number; accountId: string | null }> {
  const res = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${rawKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      input: "hi",
      ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
    }),
  });
  const accountId = await newestAccountId(db, expectedTotal);
  return { status: res.status, accountId };
}

/**
 * POST /v1/messages (Anthropic surface) carrying an optional
 * `x-claude-session-id` header (Layer 2 sticky key); drain the usage queue to
 * `expectedTotal`; return the account_id of the newest usage row.
 */
export async function postMessagesAndAccount(
  baseUrl: string, db: Database, rawKey: string, expectedTotal: number, sessionId?: string,
): Promise<{ status: number; accountId: string | null }> {
  const r = await postMessages(
    baseUrl,
    rawKey,
    undefined,
    sessionId ? { "x-claude-session-id": sessionId } : {},
  );
  const accountId = await newestAccountId(db, expectedTotal);
  return { status: r.status, accountId };
}
