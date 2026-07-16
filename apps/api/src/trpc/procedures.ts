import {
  initTRPC,
  TRPCError,
  type TRPCProcedureBuilder,
  type TRPCUnsetMarker,
} from "@trpc/server";
import type { z } from "zod";
import type { Redis } from "ioredis";
import { can, type Action } from "@caliber/auth";
import type { ServerEnv } from "@caliber/config";
import {
  runWithLocale,
  getValidationMessagesSync,
  translateValidationKey,
} from "@caliber/i18n-validation/server";
import { DEFAULT_LOCALE, type Locale } from "@caliber/i18n-validation";
import type { TrpcContext, TrpcLogger } from "./context.js";
import type { EvaluatorQueue } from "./routers/reports.js";
import type { GithubSyncQueue } from "./routers/githubDelivery.js";

// errorFormatter must be passed to initTRPC.create() so it's woven into the
// router shape — passing it via the fastify adapter's trpcOptions is silently
// ignored. Translates `validation.*`-prefixed key messages (including
// `<key>#<urlencoded-json>` produced by `formatValidationKey()`) at the
// rendering boundary, since Zod's `makeIssue()` short-circuits the global
// errorMap whenever a schema supplies an explicit message and the raw key
// would otherwise reach the wire.
const t = initTRPC.context<TrpcContext>().create({
  errorFormatter: ({ shape, ctx }) => {
    const locale = (ctx as TrpcContext | undefined)?.locale ?? DEFAULT_LOCALE;
    const messages = getValidationMessagesSync(locale);
    if (!messages) return shape;

    const flattened = shape.data as
      | {
          zodError?: {
            fieldErrors?: Record<string, string[] | undefined>;
            formErrors?: string[];
          };
          [k: string]: unknown;
        }
      | undefined;

    let translatedData: unknown = shape.data;
    if (flattened?.zodError) {
      const fe = flattened.zodError.fieldErrors ?? {};
      const newFieldErrors: Record<string, string[]> = {};
      for (const [field, errs] of Object.entries(fe)) {
        newFieldErrors[field] = (errs ?? []).map((m) =>
          translateValidationKey(messages, m),
        );
      }
      const newFormErrors = (flattened.zodError.formErrors ?? []).map((m) =>
        translateValidationKey(messages, m),
      );
      translatedData = {
        ...flattened,
        zodError: {
          ...flattened.zodError,
          fieldErrors: newFieldErrors,
          formErrors: newFormErrors,
        },
      };
    }

    const translatedMessage =
      typeof shape.message === "string"
        ? translateValidationKey(messages, shape.message)
        : shape.message;

    return {
      ...shape,
      message: translatedMessage,
      data: translatedData,
    };
  },
});

// Wrap the entire procedure pipeline (including Zod input parsing) in the
// AsyncLocalStorage scope so the global Zod errorMap reads the right locale
// at issue-time. Applied to publicProcedure so every derived procedure
// inherits it.
const withLocale = t.middleware(({ ctx, next }) =>
  runWithLocale(ctx.locale, () => next()),
);

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;
export const publicProcedure = t.procedure.use(withLocale);

// Context shape after protectedProcedure narrows user/perm to non-null.
interface ProtectedCtx {
  db: TrpcContext["db"];
  reqId: string;
  locale: Locale;
  user: { id: string; email: string };
  perm: NonNullable<TrpcContext["perm"]>;
  env: ServerEnv;
  redis: Redis;
  ipAddress: string | null;
  logger: TrpcLogger;
  evaluatorQueue?: EvaluatorQueue;
  githubSyncQueue?: GithubSyncQueue;
}

// Narrow user/perm to non-null by returning a new ctx object (tRPC v11 uses the
// returned ctx type for downstream procedures — spreading and reassigning still
// leaves the declared TrpcContext fields nullable). We forward `env` explicitly
// so downstream handlers can rely on the contract here rather than tRPC v11's
// implicit partial-ctx merge (which is correct today but undocumented).
export const protectedProcedure = publicProcedure.use(async ({ ctx, next }) => {
  if (!ctx.user || !ctx.perm) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      db: ctx.db,
      reqId: ctx.reqId,
      locale: ctx.locale,
      user: ctx.user,
      perm: ctx.perm,
      env: ctx.env,
      redis: ctx.redis,
      ipAddress: ctx.ipAddress,
      logger: ctx.logger,
      evaluatorQueue: ctx.evaluatorQueue,
      githubSyncQueue: ctx.githubSyncQueue,
    },
  });
});

// Factory that takes the zod input schema AND the permission resolver together.
// We call `.input(schema)` BEFORE `.use(...)` so the middleware receives a
// typed, validated `input`. Consumers then chain .query/.mutation directly.
//
// The explicit return annotation is required because tRPC v11's inferred
// builder type references an internal declaration bundle
// (`unstable-core-do-not-import.d-*.mts`) that TS considers non-portable when
// `declaration: true` is set in the base tsconfig — triggering TS2742. Using
// the publicly re-exported `TRPCProcedureBuilder` alias anchors the annotation
// to a portable path.
export function permissionProcedure<S extends z.ZodTypeAny>(
  schema: S,
  resolve: (
    ctx: { user: { id: string; email: string } },
    input: z.infer<S>,
  ) => Action,
): TRPCProcedureBuilder<
  TrpcContext,
  object,
  ProtectedCtx,
  z.input<S>,
  z.output<S>,
  TRPCUnsetMarker,
  TRPCUnsetMarker,
  false
> {
  return protectedProcedure.input(schema).use(async ({ ctx, input, next }) => {
    const action = resolve(ctx, input as z.infer<S>);
    if (!can(ctx.perm, action)) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    return next();
  });
}
