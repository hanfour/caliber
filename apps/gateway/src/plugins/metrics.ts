import fp from "fastify-plugin";
import * as fm from "fastify-metrics";
import type { IMetricsPluginOptions } from "fastify-metrics";
import { Counter, Histogram, Gauge, type Registry } from "prom-client";
// fastify-metrics ships CJS; interop helper ensures we get the plugin function regardless of bundler resolution
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fastifyMetrics = ((fm as any).default ?? fm) as (fm: any) => any;

export interface GatewayMetrics {
  slotAcquireTotal: Counter<"scope" | "result">;
  slotHoldDurationSeconds: Histogram<string>;
  waitQueueDepth: Gauge<string>;
  idempotencyHitTotal: Counter<string>;
  stickyHitTotal: Counter<string>;
  // Phase 3 #2 follow-up — cache hit/miss counter so operators can
  // observe hit-rate from Prometheus rather than only via the
  // `x-cache` response header on individual requests.
  gwCacheTotal: Counter<"result">;
  // Phase 3 #4-b follow-up — counts the rateLimitPlugin's fail-open
  // path (Redis error → request let through). Sustained non-zero =
  // rate limiting is silently disabled; pair with the existing
  // `gw_redis_latency_seconds` to root-cause.
  gwRateLimitFailOpenTotal: Counter<string>;
  redisLatencySeconds: Histogram<string>;
  upstreamDurationSeconds: Histogram<string>;
  pricingMissTotal: Counter<"model">;
  oauthRefreshDeadTotal: Counter<"account_id">;
  queueDepth: Gauge<string>;
  queueDlqCount: Gauge<string>;
  usagePersistLostTotal: Counter<string>;
  billingDriftTotal: Counter<string>;
  billingMonotonicityViolationTotal: Counter<string>;
  bodyCaptureEnqueuedTotal: Counter<"result">;
  bodyPurgeDeletedTotal: Counter<string>;
  bodyPurgeDurationSeconds: Histogram<string>;
  bodyPurgeLagHours: Gauge<string>;
  gwEvalLlmCalledTotal: Counter<"result">;
  gwEvalLlmCostUsd: Counter<string>;
  gwEvalLlmFailedTotal: Counter<"reason">;
  gwEvalLlmParseFailedTotal: Counter<string>;
  gwEvalDlqCount: Gauge<string>;
  gwGdprDeleteExecutedTotal: Counter<string>;
  gwGdprBodiesDeletedTotal: Counter<string>;
  gwGdprReportsDeletedTotal: Counter<string>;
  gwGdprFailuresTotal: Counter<string>;
  gwGdprAutoRejectedTotal: Counter<string>;

  // Plan 4C — cost budget infrastructure
  gwLlmCostUsdTotal: Counter<"org_id" | "event_type" | "model">;
  gwLlmBudgetWarnTotal: Counter<"org_id">;
  gwLlmBudgetExceededTotal: Counter<"org_id" | "behavior">;

  // Plan 4C Phase 2 — facet extraction (registered now; emitted in Phase 2)
  gwFacetExtractTotal: Counter<"org_id" | "result">;
  gwFacetExtractDurationMs: Histogram<"org_id">;
  gwFacetCacheHitTotal: Counter<"org_id">;

  // Plan 5A Part 7 — 3-layer account scheduler
  gwSchedulerSelectTotal: Counter<"platform" | "layer">;
  gwSchedulerStickyHitRatio: Gauge<"platform">;
  gwSchedulerAccountSwitchTotal: Counter<"platform">;
  gwSchedulerLatencyMs: Histogram<"platform">;
  gwSchedulerLoadSkew: Gauge<"platform">;
  gwSchedulerRuntimeAccountCount: Gauge<string>;
}

declare module "fastify" {
  interface FastifyInstance {
    gwMetrics: GatewayMetrics;
  }
}

export const metricsPlugin = fp(metricsPluginBody, { name: "metricsPlugin" });

async function metricsPluginBody(
  fastify: import("fastify").FastifyInstance,
): Promise<void> {
  await fastify.register(fastifyMetrics, {
    endpoint: "/metrics",
    // Owns the prom-client default singleton; no other process module should register against it.
    clearRegisterOnInit: true,
    routeMetrics: { enabled: true },
    defaultMetrics: { enabled: true },
  });

  // fastify.metrics.client is the prom-client module; .register is the global registry
  const register = fastify.metrics.client.register as Registry;

  const slotAcquireTotal = new Counter({
    name: "gw_slot_acquire_total",
    help: "Slot acquisition attempts",
    labelNames: ["scope", "result"] as const,
    registers: [register],
  });

  // TODO(part-5): tune buckets for upstream durations >10s; defaults are HTTP-shaped
  const slotHoldDurationSeconds = new Histogram({
    name: "gw_slot_hold_duration_seconds",
    help: "Time a slot was held",
    registers: [register],
  });

  const waitQueueDepth = new Gauge({
    name: "gw_wait_queue_depth",
    help: "Current wait-queue depth",
    registers: [register],
  });

  const idempotencyHitTotal = new Counter({
    name: "gw_idempotency_hit_total",
    help: "Idempotency cache hits",
    registers: [register],
  });

  const stickyHitTotal = new Counter({
    name: "gw_sticky_hit_total",
    help: "Sticky-session cache hits",
    registers: [register],
  });

  const gwCacheTotal = new Counter({
    name: "gw_cache_total",
    help: "Response-cache hit/miss counter (only emitted when GATEWAY_CACHE_TTL_SEC > 0)",
    labelNames: ["result"] as const,
    registers: [register],
  });

  const gwRateLimitFailOpenTotal = new Counter({
    name: "gw_rate_limit_fail_open_total",
    help: "Per-apiKey rate-limit checks that hit the fail-open path due to Redis errors",
    registers: [register],
  });

  const redisLatencySeconds = new Histogram({
    name: "gw_redis_latency_seconds",
    help: "Redis call latency",
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [register],
  });

  // TODO(part-5): tune buckets for upstream durations >10s; defaults are HTTP-shaped
  const upstreamDurationSeconds = new Histogram({
    name: "gw_upstream_duration_seconds",
    help: "Upstream API call duration",
    registers: [register],
  });

  const pricingMissTotal = new Counter({
    name: "gw_pricing_miss_total",
    help: "Pricing lookup misses",
    labelNames: ["model"] as const,
    registers: [register],
  });

  const oauthRefreshDeadTotal = new Counter({
    name: "gw_oauth_refresh_dead_total",
    help: "OAuth refresh failures past max",
    labelNames: ["account_id"] as const,
    registers: [register],
  });

  const queueDepth = new Gauge({
    name: "gw_queue_depth",
    help: "BullMQ wait+active count",
    registers: [register],
  });

  const queueDlqCount = new Gauge({
    name: "gw_queue_dlq_count",
    help: "BullMQ failed (DLQ) count",
    registers: [register],
  });

  // Rare event: BOTH the BullMQ enqueue AND the inline DB fallback failed,
  // so the usage_logs row was dropped.  Surfaces in dashboards as a
  // monotonic counter; any non-zero rate should page (Plan 4A Part 7
  // Section 5.1).
  const usagePersistLostTotal = new Counter({
    name: "gw_usage_persist_lost_total",
    help: "Usage log rows dropped after BullMQ + inline DB write both failed",
    registers: [register],
  });

  // Hourly billing audit (Plan 4A Part 7, Task 7.4) samples 1% of api_keys
  // and compares SUM(usage_logs.total_cost) against api_keys.quota_used_usd.
  // Drift > 0.01 USD (in either direction) bumps the drift counter; the
  // sub-case where quota_used_usd > sum-of-logs (i.e., quota was charged
  // for a row that no longer exists in usage_logs) is a monotonicity
  // violation and bumps a separate counter.  Both should stay flat in
  // steady-state; any non-zero rate is a billing-integrity signal.
  const billingDriftTotal = new Counter({
    name: "gw_billing_drift_total",
    help: "API keys whose |SUM(usage_logs.total_cost) - quota_used_usd| > $0.01",
    registers: [register],
  });

  const billingMonotonicityViolationTotal = new Counter({
    name: "gw_billing_monotonicity_violation_total",
    help: "API keys where SUM(usage_logs.total_cost) < quota_used_usd (monotonicity violation)",
    registers: [register],
  });

  const bodyCaptureEnqueuedTotal = new Counter({
    name: "gw_body_capture_enqueued_total",
    help: "Body capture job enqueue attempts",
    labelNames: ["result"] as const,
    registers: [register],
  });

  const bodyPurgeDeletedTotal = new Counter({
    name: "gw_body_purge_deleted_total",
    help: "Total request_bodies rows purged by retention cron",
    registers: [register],
  });

  const bodyPurgeDurationSeconds = new Histogram({
    name: "gw_body_purge_duration_seconds",
    help: "Duration of body purge cron tick in seconds",
    buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 300],
    registers: [register],
  });

  const bodyPurgeLagHours = new Gauge({
    name: "gw_body_purge_lag_hours",
    help: "Hours between oldest-overdue retention_until and now (0 when queue clean)",
    registers: [register],
  });

  const gwEvalLlmCalledTotal = new Counter({
    name: "gw_eval_llm_called_total",
    help: "LLM deep analysis calls attempted (before knowing success/fail)",
    labelNames: ["result"] as const,
    registers: [register],
  });

  const gwEvalLlmCostUsd = new Counter({
    name: "gw_eval_llm_cost_usd",
    help: "Cumulative cost of LLM deep analysis calls in USD",
    registers: [register],
  });

  const gwEvalLlmFailedTotal = new Counter({
    name: "gw_eval_llm_failed_total",
    help: "LLM deep analysis failures by reason",
    labelNames: ["reason"] as const,
    registers: [register],
  });

  const gwEvalLlmParseFailedTotal = new Counter({
    name: "gw_eval_llm_parse_failed_total",
    help: "LLM deep analysis responses that failed JSON/schema validation",
    registers: [register],
  });

  const gwEvalDlqCount = new Gauge({
    name: "gw_eval_dlq_count",
    help: "Evaluator jobs in BullMQ DLQ (failed after all retry attempts)",
    registers: [register],
  });

  const gwGdprDeleteExecutedTotal = new Counter({
    name: "gw_gdpr_delete_executed_total",
    help: "Total GDPR delete requests executed by the 5-min cron",
    registers: [register],
  });

  const gwGdprBodiesDeletedTotal = new Counter({
    name: "gw_gdpr_bodies_deleted_total",
    help: "Total request_bodies rows deleted by GDPR delete cron",
    registers: [register],
  });

  const gwGdprReportsDeletedTotal = new Counter({
    name: "gw_gdpr_reports_deleted_total",
    help: "Total evaluation_reports rows deleted by GDPR delete cron",
    registers: [register],
  });

  const gwGdprFailuresTotal = new Counter({
    name: "gw_gdpr_failures_total",
    help: "GDPR delete requests that failed during execution",
    registers: [register],
  });

  const gwGdprAutoRejectedTotal = new Counter({
    name: "gw_gdpr_auto_rejected_total",
    help: "GDPR delete requests auto-rejected after SLA expiry",
    registers: [register],
  });

  // Plan 4C — cost budget infrastructure
  // Cumulative LLM cost in USD per org / event_type / model. Emitted from
  // `createLedgerWriter` after each successful ledger insert.
  const gwLlmCostUsdTotal = new Counter({
    name: "gw_llm_cost_usd_total",
    help: "Cumulative LLM cost in USD per org/event_type/model",
    labelNames: ["org_id", "event_type", "model"] as const,
    registers: [register],
  });

  // Soft warning when an org's month-to-date spend crosses 80% of its budget.
  // Emitted from `wrapEnforceBudget` after a successful enforce.
  const gwLlmBudgetWarnTotal = new Counter({
    name: "gw_llm_budget_warn_total",
    help: "LLM budget soft-warning trips (>= 80% of monthly budget)",
    labelNames: ["org_id"] as const,
    registers: [register],
  });

  // Hard breach: org went over budget. Behavior label distinguishes degrade
  // (drop the deep-analysis call but keep rule-based) vs halt (block until
  // month rolls over). Emitted from `wrapEnforceBudget` on throw.
  const gwLlmBudgetExceededTotal = new Counter({
    name: "gw_llm_budget_exceeded_total",
    help: "LLM budget exceeded events by overage behavior",
    labelNames: ["org_id", "behavior"] as const,
    registers: [register],
  });

  // Plan 4C Phase 2 — facet extraction (registered now; emitted in Phase 2).
  // `result` label values used in Phase 2:
  //   success | parse_error | validation_error | timeout | api_error | budget_skip
  const gwFacetExtractTotal = new Counter({
    name: "gw_facet_extract_total",
    help: "Facet extraction attempts by result",
    labelNames: ["org_id", "result"] as const,
    registers: [register],
  });

  // Latency of facet extraction LLM calls. Anthropic latencies typically span
  // ~100ms – 30s; buckets sized for that range.
  const gwFacetExtractDurationMs = new Histogram({
    name: "gw_facet_extract_duration_ms",
    help: "Facet extraction duration in milliseconds",
    labelNames: ["org_id"] as const,
    buckets: [100, 250, 500, 1000, 2500, 5000, 10000, 15000, 30000],
    registers: [register],
  });

  const gwFacetCacheHitTotal = new Counter({
    name: "gw_facet_cache_hit_total",
    help: "Facet extraction cache hits per org",
    labelNames: ["org_id"] as const,
    registers: [register],
  });

  // Plan 5A Part 7 — 3-layer scheduler metrics. `layer` distinguishes
  // sticky (Layer 1 / 2) from cold-path (Layer 3 load_balance) decisions.
  const gwSchedulerSelectTotal = new Counter({
    name: "gw_scheduler_select_total",
    help: "Account scheduler decisions, broken down by layer",
    labelNames: ["platform", "layer"] as const,
    registers: [register],
  });

  const gwSchedulerStickyHitRatio = new Gauge({
    name: "gw_scheduler_sticky_hit_ratio",
    help: "EWMA of sticky-layer hits / total decisions per platform",
    labelNames: ["platform"] as const,
    registers: [register],
  });

  const gwSchedulerAccountSwitchTotal = new Counter({
    name: "gw_scheduler_account_switch_total",
    help: "Failover events where the scheduler had to switch accounts",
    labelNames: ["platform"] as const,
    registers: [register],
  });

  // Decision latency in milliseconds — from select() entry to candidate return.
  const gwSchedulerLatencyMs = new Histogram({
    name: "gw_scheduler_latency_ms",
    help: "Account scheduler decision latency in milliseconds",
    labelNames: ["platform"] as const,
    buckets: [0.1, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500],
    registers: [register],
  });

  const gwSchedulerLoadSkew = new Gauge({
    name: "gw_scheduler_load_skew",
    help: "Last-decision load skew = (max - min) / mean of candidate weights",
    labelNames: ["platform"] as const,
    registers: [register],
  });

  const gwSchedulerRuntimeAccountCount = new Gauge({
    name: "gw_scheduler_runtime_account_count",
    help: "Accounts currently tracked in the scheduler EWMA stats (global)",
    registers: [register],
  });
  gwSchedulerRuntimeAccountCount.set(0);

  // Materialize zero values so unlabeled metrics appear in scrape output
  waitQueueDepth.set(0);
  idempotencyHitTotal.inc(0);
  stickyHitTotal.inc(0);
  queueDepth.set(0);
  queueDlqCount.set(0);
  usagePersistLostTotal.inc(0);
  billingDriftTotal.inc(0);
  billingMonotonicityViolationTotal.inc(0);
  gwEvalLlmCalledTotal.inc(0);
  gwEvalLlmCostUsd.inc(0);
  gwEvalLlmFailedTotal.inc(0);
  gwEvalLlmParseFailedTotal.inc(0);
  gwEvalDlqCount.set(0);
  gwGdprDeleteExecutedTotal.inc(0);
  gwGdprBodiesDeletedTotal.inc(0);
  gwGdprReportsDeletedTotal.inc(0);
  gwGdprFailuresTotal.inc(0);
  gwGdprAutoRejectedTotal.inc(0);
  // Histograms appear as _count/_sum=0 without an explicit observation

  // Initialise zero so the new counters appear immediately in /metrics.
  gwCacheTotal.inc({ result: "hit" }, 0);
  gwCacheTotal.inc({ result: "miss" }, 0);
  gwRateLimitFailOpenTotal.inc(0);

  fastify.decorate("gwMetrics", {
    slotAcquireTotal,
    slotHoldDurationSeconds,
    waitQueueDepth,
    idempotencyHitTotal,
    stickyHitTotal,
    gwCacheTotal,
    gwRateLimitFailOpenTotal,
    redisLatencySeconds,
    upstreamDurationSeconds,
    pricingMissTotal,
    oauthRefreshDeadTotal,
    queueDepth,
    queueDlqCount,
    usagePersistLostTotal,
    billingDriftTotal,
    billingMonotonicityViolationTotal,
    bodyCaptureEnqueuedTotal,
    bodyPurgeDeletedTotal,
    bodyPurgeDurationSeconds,
    bodyPurgeLagHours,
    gwEvalLlmCalledTotal,
    gwEvalLlmCostUsd,
    gwEvalLlmFailedTotal,
    gwEvalLlmParseFailedTotal,
    gwEvalDlqCount,
    gwGdprDeleteExecutedTotal,
    gwGdprBodiesDeletedTotal,
    gwGdprReportsDeletedTotal,
    gwGdprFailuresTotal,
    gwGdprAutoRejectedTotal,
    gwLlmCostUsdTotal,
    gwLlmBudgetWarnTotal,
    gwLlmBudgetExceededTotal,
    gwFacetExtractTotal,
    gwFacetExtractDurationMs,
    gwFacetCacheHitTotal,
    gwSchedulerSelectTotal,
    gwSchedulerStickyHitRatio,
    gwSchedulerAccountSwitchTotal,
    gwSchedulerLatencyMs,
    gwSchedulerLoadSkew,
    gwSchedulerRuntimeAccountCount,
  });
}
