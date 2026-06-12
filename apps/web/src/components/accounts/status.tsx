"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { toDate } from "@/lib/time";
import { cn } from "@/lib/utils";

export type AccountStatus =
  | "disabled"
  | "rate_limited"
  | "overloaded"
  | "credential_invalid"
  | "paused"
  | "expired"
  | "error"
  | "active";

export type StatusTone = "success" | "warning" | "destructive" | "muted";

// Structural input for status derivation. `AccountRow` (the full tRPC-inferred
// row type in AccountList.tsx) structurally satisfies this, so passing a row
// directly works without any cast.
//
// Timestamps are typed `Date | string | null` because tRPC without a superjson
// transformer serializes Dates as ISO strings over the wire. The inferred
// router output on the client therefore yields `string | null` for timestamp
// columns, even though the Drizzle source type is `Date | null`. Accepting
// both keeps this helper usable from the server (Date) and the client (string)
// without forcing either caller to pre-normalize.
export interface AccountStatusInput {
  schedulable: boolean;
  rateLimitedAt: Date | string | null;
  rateLimitResetAt: Date | string | null;
  overloadUntil: Date | string | null;
  tempUnschedulableUntil: Date | string | null;
  tempUnschedulableReason?: string | null;
  expiresAt: Date | string | null;
  errorMessage: string | null;
  status: string;
}

// Precedence order matters: the most actionable/terminal state wins. A rate-
// limited account that is also disabled is displayed as `disabled` (operator
// turned it off — that's the truth), and an expired account wins over a
// generic `error` because "expired" is a more specific diagnosis.
// disabled > rate_limited > overloaded > credential_invalid > paused > expired > error > active
export function deriveAccountStatus(
  row: AccountStatusInput,
  now: Date = new Date(),
): AccountStatus {
  if (!row.schedulable) return "disabled";

  const rateLimitedAt = toDate(row.rateLimitedAt);
  const rateLimitResetAt = toDate(row.rateLimitResetAt);
  if (rateLimitedAt && (!rateLimitResetAt || rateLimitResetAt > now)) {
    return "rate_limited";
  }

  const overloadUntil = toDate(row.overloadUntil);
  if (overloadUntil && overloadUntil > now) return "overloaded";

  if (row.tempUnschedulableReason === "api_key_invalid_credential") {
    return "credential_invalid";
  }

  const pausedUntil = toDate(row.tempUnschedulableUntil);
  if (pausedUntil && pausedUntil > now) return "paused";

  const expiresAt = toDate(row.expiresAt);
  if (expiresAt && expiresAt <= now) return "expired";

  // Catch-all for unknown DB status values. The `status` column has no enum
  // constraint, so any future non-"active" value (e.g., `suspended`, `pending`)
  // will surface here as `error`. If you add a first-class status, route it to
  // its own branch above this one.
  if (
    (row.errorMessage && row.errorMessage.length > 0) ||
    row.status !== "active"
  ) {
    return "error";
  }

  return "active";
}

// English source-of-truth labels. Kept exported for non-React callers
// (CSV exports, server-side log helpers, …) that can't reach
// `useTranslations`. The interactive `<StatusBadge>` below resolves the
// label via `common.*` keys instead so the badge respects the user's
// locale.
export const STATUS_LABEL: Record<AccountStatus, string> = {
  active: "Active",
  disabled: "Disabled",
  rate_limited: "Rate limited",
  overloaded: "Overloaded",
  credential_invalid: "Credential rejected — rotate",
  paused: "Paused",
  expired: "Expired",
  error: "Error",
};

const STATUS_LABEL_KEY: Record<AccountStatus, string> = {
  active: "active",
  disabled: "disabled",
  rate_limited: "rateLimited",
  overloaded: "overloaded",
  credential_invalid: "credentialInvalid",
  paused: "paused",
  expired: "expired",
  error: "error",
};

export const STATUS_TONE: Record<AccountStatus, StatusTone> = {
  active: "success",
  disabled: "muted",
  rate_limited: "warning",
  overloaded: "warning",
  credential_invalid: "destructive",
  paused: "warning",
  expired: "destructive",
  error: "destructive",
};

// Apple-ish soft tones — solid bg at ~10% opacity with saturated foreground.
// Kept as className overrides on the existing Badge component (variant=outline
// strips its own bg/border) so we don't redesign the shared badge.
export const TONE_CLASSNAME: Record<StatusTone, string> = {
  success:
    "border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  warning:
    "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  destructive:
    "border-transparent bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300",
  muted:
    "border-transparent bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-300",
};

export function StatusBadge({ status }: { status: AccountStatus }) {
  const t = useTranslations("common");
  return (
    <Badge
      variant="outline"
      className={cn("font-medium", TONE_CLASSNAME[STATUS_TONE[status]])}
    >
      {t(STATUS_LABEL_KEY[status])}
    </Badge>
  );
}
