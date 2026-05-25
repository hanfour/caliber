import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { createGunzip } from "node:zlib";
import {
  devices,
  clientSessions,
  clientEvents,
} from "@caliber/db";
import type { ServerEnv } from "@caliber/config";
import { resolveDeviceFromAuth, type ResolvedDevice } from "./ingestAuth.js";

// POST /v1/ingest — daemon-facing transcript shipping endpoint.
// Bearer-auth with `cda_*` device keys: server resolves device_id/user_id/org_id
// from the key and NEVER trusts the body's `device_id`. Session upsert carries
// a tenant guard via setWhere so a daemon claiming a session_id already owned
// by another org is rejected with 409 SESSION_OWNED_BY_OTHER_ORG. Events are
// inserted with ON CONFLICT DO NOTHING for daemon retry idempotence.

const INGEST_BODY_LIMIT = 50 * 1024 * 1024; // 50 MB raw (compressed wire bytes)

const tokensSchema = z
  .object({
    input: z.number().int().nullable().optional(),
    output: z.number().int().nullable().optional(),
    cache_read: z.number().int().nullable().optional(),
    cache_creation: z.number().int().nullable().optional(),
    reasoning: z.number().int().nullable().optional(),
  })
  .partial()
  .nullable()
  .optional();

const eventSchema = z.object({
  event_id: z.string().min(1).max(200),
  parent_event_id: z.string().min(1).max(200).nullable().optional(),
  turn_id: z.string().max(200).nullable().optional(),
  role: z.string().max(64).nullable().optional(),
  event_type: z.string().min(1).max(64),
  timestamp: z.string().min(1),
  content: z.unknown().nullable().optional(),
  tokens: tokensSchema,
});

const sessionStaticSchema = z
  .object({
    cwd: z.string().nullable().optional(),
    git: z
      .object({
        commit: z.string().nullable().optional(),
        branch: z.string().nullable().optional(),
        remote: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    cli_version: z.string().nullable().optional(),
    model_provider: z.string().nullable().optional(),
    base_instructions_hash: z.string().nullable().optional(),
    base_instructions_text: z.string().nullable().optional(),
  })
  .partial()
  .default({});

const sessionSchema = z.object({
  session_id: z.string().min(1).max(200),
  parent_session_id: z.string().min(1).max(200).nullable().optional(),
  source_client: z.string().min(1).max(64),
  static: sessionStaticSchema,
  events: z.array(z.unknown()),
});

const ingestBodySchema = z.object({
  device_id: z.string().optional(), // ignored; server overrides from auth
  agent_version: z.string().min(1).max(64),
  redaction_mode: z.enum(["metadata-only", "redacted-body", "full-body"]),
  sessions: z.array(sessionSchema).max(500),
});


interface IngestError {
  session_id?: string;
  event_id?: string;
  error: string;
}

// Streaming gunzip with a hard cap on the decompressed byte total. Aborts
// as soon as the cap is exceeded so a gzip bomb (small wire, gigabytes
// decoded) cannot consume memory beyond `limit`. Used to be `gunzipSync`,
// which trusted the compressor and only honoured the wire-side bodyLimit.
async function gunzipWithLimit(buf: Buffer, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    gunzip.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        aborted = true;
        const e = new Error("decompressed_too_large") as Error & {
          statusCode?: number;
        };
        e.statusCode = 413;
        gunzip.destroy(e);
        return;
      }
      chunks.push(chunk);
    });
    gunzip.on("end", () => {
      if (!aborted) resolve(Buffer.concat(chunks));
    });
    gunzip.on("error", reject);
    gunzip.end(buf);
  });
}

// Per-request decoration so the handler can read the device the
// preHandler hook resolved. Declared via Fastify's decorateRequest so
// the property exists with a stable shape.
interface IngestRequest extends FastifyRequest {
  resolvedDevice?: ResolvedDevice;
}

export function ingestRoutes(env: ServerEnv): FastifyPluginAsync {
  return async (fastify) => {
    fastify.decorateRequest("resolvedDevice", null);

    // Auth runs in onRequest — before the JSON content-type parser. A
    // failed auth short-circuits with 401 and Fastify never invokes the
    // parser, so the gzip body is not decompressed. Defends against an
    // unauthenticated gzip-bomb DoS.
    fastify.addHook("onRequest", async (req, reply) => {
      if (req.method !== "POST" || req.url.split("?")[0] !== "/v1/ingest") {
        return;
      }
      if (!env.ENABLE_GATEWAY) {
        reply.code(404).send({ error: "not_found" });
        return reply;
      }
      const auth = await resolveDeviceFromAuth(
        fastify.db,
        env,
        req.headers.authorization,
      );
      if (auth.ok === false && auth.error === "server_misconfigured") {
        reply.code(500).send({ error: "server_misconfigured" });
        return reply;
      }
      if (!auth.ok) {
        reply.code(401).send({ error: auth.error });
        return reply;
      }
      (req as IngestRequest).resolvedDevice = auth.device;
    });

    // Scoped JSON parser: handles gzipped + raw JSON within this plugin only.
    // The default fastify parser is removed so we own the application/json path
    // (including content-encoding: gzip decoding with a decompressed-size cap).
    fastify.removeContentTypeParser("application/json");
    fastify.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: INGEST_BODY_LIMIT },
      async (req: FastifyRequest, body: Buffer) => {
        try {
          const buf = body as Buffer;
          const enc = String(req.headers["content-encoding"] ?? "").toLowerCase();
          const utf8 = enc.includes("gzip")
            ? (
                await gunzipWithLimit(buf, env.INGEST_MAX_DECOMPRESSED_BYTES)
              ).toString("utf8")
            : buf.toString("utf8");
          return JSON.parse(utf8);
        } catch (err) {
          const e =
            err instanceof Error ? err : new Error("invalid_json");
          const statusCode =
            (e as Error & { statusCode?: number }).statusCode ?? 400;
          (e as Error & { statusCode?: number }).statusCode = statusCode;
          throw e;
        }
      },
    );

    fastify.post(
      "/v1/ingest",
      { bodyLimit: INGEST_BODY_LIMIT },
      async (req, reply) => {
        // Auth already enforced in onRequest; resolvedDevice is guaranteed
        // present here. The defensive nullish check pacifies the type system
        // and surfaces a clear 500 if a future refactor decouples the hook.
        const device = (req as IngestRequest).resolvedDevice;
        if (!device) {
          reply.code(500);
          return { error: "auth_state_missing" };
        }
        const { deviceId, userId, orgId } = device;

        const parsed = ingestBodySchema.safeParse(req.body);
        if (!parsed.success) {
          reply.code(400);
          return { error: "invalid_body", details: parsed.error.flatten() };
        }

        const errors: IngestError[] = [];
        let ingested = 0;
        let deduped = 0;
        let sessionUpserts = 0;
        let tenantCollision = false;

        for (const session of parsed.data.sessions) {
          interface ValidEvent {
            eventId: string;
            parentEventId: string | null;
            turnId: string | null;
            role: string | null;
            eventType: string;
            timestamp: Date;
            content: unknown;
            inputTokens: number | null;
            outputTokens: number | null;
            cacheReadTokens: number | null;
            cacheCreationTokens: number | null;
            reasoningTokens: number | null;
          }

          const validEvents: ValidEvent[] = [];
          for (const rawEvent of session.events) {
            const ep = eventSchema.safeParse(rawEvent);
            if (!ep.success) {
              errors.push({
                session_id: session.session_id,
                error: "malformed_event",
              });
              continue;
            }
            const ts = new Date(ep.data.timestamp);
            if (Number.isNaN(ts.getTime())) {
              errors.push({
                session_id: session.session_id,
                event_id: ep.data.event_id,
                error: "invalid_timestamp",
              });
              continue;
            }
            validEvents.push({
              eventId: ep.data.event_id,
              parentEventId: ep.data.parent_event_id ?? null,
              turnId: ep.data.turn_id ?? null,
              role: ep.data.role ?? null,
              eventType: ep.data.event_type,
              timestamp: ts,
              content: ep.data.content ?? null,
              inputTokens: ep.data.tokens?.input ?? null,
              outputTokens: ep.data.tokens?.output ?? null,
              cacheReadTokens: ep.data.tokens?.cache_read ?? null,
              cacheCreationTokens: ep.data.tokens?.cache_creation ?? null,
              reasoningTokens: ep.data.tokens?.reasoning ?? null,
            });
          }

          const tsList = validEvents.map((e) => e.timestamp.getTime());
          const startedAt =
            tsList.length > 0 ? new Date(Math.min(...tsList)) : new Date();
          const lastEventAt =
            tsList.length > 0 ? new Date(Math.max(...tsList)) : startedAt;

          // Tenant-guarded upsert: setWhere clause means an existing row owned
          // by another org returns no row, signalling collision. We use the
          // returned id presence as the success indicator.
          let upsertedId: string | undefined;
          try {
            const result = await fastify.db
              .insert(clientSessions)
              .values({
                id: session.session_id,
                parentSessionId: session.parent_session_id ?? null,
                deviceId,
                userId,
                orgId,
                sourceClient: session.source_client,
                cwd: session.static.cwd ?? null,
                gitCommitHash: session.static.git?.commit ?? null,
                gitBranch: session.static.git?.branch ?? null,
                gitRemoteUrl: session.static.git?.remote ?? null,
                cliVersion: session.static.cli_version ?? null,
                modelProvider: session.static.model_provider ?? null,
                baseInstructionsHash:
                  session.static.base_instructions_hash ?? null,
                baseInstructionsText:
                  session.static.base_instructions_text ?? null,
                startedAt,
                lastEventAt,
              })
              .onConflictDoUpdate({
                target: clientSessions.id,
                set: {
                  lastEventAt: sql`GREATEST(${clientSessions.lastEventAt}, EXCLUDED.last_event_at)`,
                  baseInstructionsText: sql`COALESCE(${clientSessions.baseInstructionsText}, EXCLUDED.base_instructions_text)`,
                },
                setWhere: sql`${clientSessions.orgId} = EXCLUDED.org_id`,
              })
              .returning({ id: clientSessions.id });
            upsertedId = result[0]?.id;
          } catch (err) {
            fastify.log.warn(
              { err, sessionId: session.session_id },
              "ingest session upsert failed",
            );
            errors.push({
              session_id: session.session_id,
              error: "session_upsert_failed",
            });
            continue;
          }

          if (!upsertedId) {
            tenantCollision = true;
            errors.push({
              session_id: session.session_id,
              error: "SESSION_OWNED_BY_OTHER_ORG",
            });
            continue;
          }
          sessionUpserts += 1;

          if (validEvents.length === 0) continue;

          // App-level dedup: the UNIQUE constraint on client_events includes
          // `ingested_at` (forced by Postgres's partition-key-in-every-unique
          // rule), so retries with different timestamps don't conflict at the
          // DB layer. SELECT existing event_ids in the (session_id, source)
          // scope and filter the batch before INSERT. The remaining ON
          // CONFLICT DO NOTHING is a millisecond-race safety net for the rare
          // concurrent same-payload-twice case within a single partition.
          const batchEventIds = validEvents.map((e) => e.eventId);
          let existingSet: Set<string>;
          try {
            const existing = await fastify.db
              .select({ eventId: clientEvents.eventId })
              .from(clientEvents)
              .where(
                and(
                  eq(clientEvents.sessionId, session.session_id),
                  eq(clientEvents.source, "transcript"),
                  inArray(clientEvents.eventId, batchEventIds),
                ),
              );
            existingSet = new Set(existing.map((r) => r.eventId));
          } catch (err) {
            fastify.log.warn(
              { err, sessionId: session.session_id },
              "ingest dedup probe failed",
            );
            errors.push({
              session_id: session.session_id,
              error: "events_insert_failed",
            });
            continue;
          }

          const eventRows = validEvents
            .filter((e) => !existingSet.has(e.eventId))
            .map((e) => ({
              orgId,
              deviceId,
              sessionId: session.session_id,
              eventId: e.eventId,
              parentEventId: e.parentEventId,
              turnId: e.turnId,
              role: e.role,
              eventType: e.eventType,
              timestamp: e.timestamp,
              content: e.content,
              inputTokens: e.inputTokens,
              outputTokens: e.outputTokens,
              cacheReadTokens: e.cacheReadTokens,
              cacheCreationTokens: e.cacheCreationTokens,
              reasoningTokens: e.reasoningTokens,
              source: "transcript" as const,
            }));

          deduped += existingSet.size;

          if (eventRows.length === 0) continue;

          try {
            const inserted = await fastify.db
              .insert(clientEvents)
              .values(eventRows)
              .onConflictDoNothing()
              .returning({ id: clientEvents.id });
            ingested += inserted.length;
            // The remainder (eventRows.length - inserted.length) lost the
            // millisecond race and counts as deduped too.
            deduped += eventRows.length - inserted.length;
          } catch (err) {
            fastify.log.warn(
              { err, sessionId: session.session_id, count: eventRows.length },
              "ingest events insert failed",
            );
            errors.push({
              session_id: session.session_id,
              error: "events_insert_failed",
            });
          }
        }

        // Bump device.last_seen_at synchronously so the response reflects the
        // observed device state. The cost is ~1ms per ingest call. Failure
        // here is logged but does not fail the request.
        try {
          await fastify.db
            .update(devices)
            .set({ lastSeenAt: sql`NOW()` })
            .where(eq(devices.id, deviceId));
        } catch (err) {
          fastify.log.warn({ err, deviceId }, "device.lastSeenAt bump failed");
        }

        if (tenantCollision && sessionUpserts === 0) {
          reply.code(409);
          return {
            error: "SESSION_OWNED_BY_OTHER_ORG",
            ingested,
            deduped,
            session_upserts: sessionUpserts,
            errors,
          };
        }

        reply.code(200);
        return {
          ingested,
          deduped,
          session_upserts: sessionUpserts,
          errors,
        };
      },
    );
  };
}
