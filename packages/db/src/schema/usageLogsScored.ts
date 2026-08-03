import { pgView } from "drizzle-orm/pg-core";
import { isNull } from "drizzle-orm";
import { usageLogs } from "./usageLogs.js";

/**
 * 評分側唯一該讀的來源。重放流量在此被排除，使得「忘記加 WHERE」不再可能
 * 造成考績被灌分——新寫的評分程式碼沿用慣例即自動安全。
 *
 * 定義必須與 packages/db/drizzle/0034_replay_runs.sql 中手寫的 CREATE VIEW
 * 完全一致。本專案的 migration 是手寫的，不跑 drizzle-kit generate。
 */
export const usageLogsScored = pgView("usage_logs_scored").as((qb) =>
  qb.select().from(usageLogs).where(isNull(usageLogs.replayOfRequestId)),
);
