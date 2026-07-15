import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "../procedures.js";

/** github-delivery procedures 404 (anti-enumeration) when the flag is off. */
export const githubProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!ctx.env.ENABLE_GITHUB_DELIVERY) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
  return next();
});
