// Shared model-alias wiring helpers (feat/model-alias-resolution).
//
// These three helpers are reused verbatim across every proxy surface that
// resolves aliases — the Anthropic `/v1/messages` route (Task 17) and the
// OpenAI `chatCompletions` / `responses` / `codexResponses` routes (Task 18).
// Extracted here so the scope-construction, header+metric emission, and
// per-attempt body rewrite stay single-sourced rather than copy-pasted into
// each route (each non-trivial enough that drift would be a latent bug).
//
// The only per-surface variation is the metrics `platform` label, threaded in
// as an argument to `applyAliasResolved` (and used directly at the streaming
// per-attempt metric sites).

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Resolved as ResolvedModel } from "./applyModelResolution.js";
import type { ScheduleRequest } from "../runtime/scheduler.js";

/** Metrics `platform` label space for the alias-resolved counter. */
export type AliasPlatformLabel = "anthropic" | "openai";

/**
 * Build the minimal scheduler-request scope `listCandidateTypes` reads — the
 * SAME six request-derived fields `buildFailoverInput` populates, mapped to the
 * exact shape `runFailover` forwards into `scheduler.select` (notably
 * `groupPlatform = ctx.platform` and `groupId = apiKey.groupId ?? undefined`).
 * Keeping this in lock-step means the bucket preview that decides cacheability
 * sees the identical candidate set the real failover loop will schedule over.
 */
export function buildAliasScope(req: FastifyRequest): ScheduleRequest {
  const apiKey = req.apiKey;
  if (!apiKey) {
    throw new Error(
      "buildAliasScope: req.apiKey is missing (apiKeyAuth middleware did not run)",
    );
  }
  const ctx = req.gwGroupContext;
  if (!ctx) {
    throw new Error(
      "buildAliasScope: req.gwGroupContext is missing (groupContext middleware did not run)",
    );
  }
  return {
    orgId: apiKey.orgId,
    teamId: apiKey.teamId,
    groupPlatform: ctx.platform,
    groupId: apiKey.groupId ?? undefined,
    routingPolicy: ctx.policy,
    userId: apiKey.userId,
  };
}

/**
 * Surface a resolved alias to the caller + metrics: emit the
 * `x-caliber-resolved-model` response header (so the client learns the concrete
 * id its alias mapped to) and bump `gw_model_alias_resolved_total`. Idempotent
 * w.r.t. the header — Fastify's `reply.header` overwrites — so a per-attempt
 * call after an upfront call simply re-affirms the same value. The `platform`
 * label distinguishes anthropic vs openai surfaces.
 */
export function applyAliasResolved(
  app: FastifyInstance,
  reply: FastifyReply,
  resolved: ResolvedModel,
  platform: AliasPlatformLabel,
): void {
  reply.header("x-caliber-resolved-model", resolved.upstreamModel);
  app.gwMetrics.modelAliasResolvedTotal.inc({
    platform,
    family: resolved.family ?? "",
  });
}

/**
 * Per-attempt upstream body for the mixed-bucket path: re-serialize the body
 * with `model` set to the bucket-specific resolved id. Only invoked when
 * `resolution.upfront === null` (the upfront path already baked the resolved id
 * into the forwarded buffer). Returns the original buffer untouched when the
 * resolver was a no-op (alias disabled / not an alias) so we never re-encode
 * needlessly. The buffer is a JSON object the route built, so the parse is
 * safe; on the off chance it isn't, fall back to the original buffer.
 */
export function rewriteUpstreamModel(
  upstreamBodyBuf: Buffer,
  resolved: ResolvedModel,
): Buffer {
  try {
    const parsed = JSON.parse(upstreamBodyBuf.toString("utf8")) as Record<
      string,
      unknown
    >;
    if (parsed.model === resolved.upstreamModel) return upstreamBodyBuf;
    return Buffer.from(
      JSON.stringify({ ...parsed, model: resolved.upstreamModel }),
    );
  } catch {
    return upstreamBodyBuf;
  }
}
