"use client";

import { useForm } from "react-hook-form";
import { z } from "zod";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useTranslatedZodResolver } from "@/lib/i18n/useTranslatedZodResolver";
import { trpc } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Copied from UpstreamRegisterDialog — the app has no shared <Textarea>
// primitive yet.
const TEXTAREA_CLASS =
  "flex w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

// ─── Types (mirrors the select map in
// apps/api/src/trpc/routers/githubDelivery.ts `getConnection`) ───────────────

interface ConnectionData {
  ownerLogin: string;
  tokenLast4: string;
  repoAllowlist: string[] | null;
  deliveryEnabled: boolean;
  status: string;
  lastSyncAt: string | null;
  lastSyncError: string | null;
}

const KNOWN_STATUSES = ["ok", "auth_error", "rate_limited", "sync_error"] as const;
type KnownStatus = (typeof KNOWN_STATUSES)[number];

function isKnownStatus(value: string): value is KnownStatus {
  return (KNOWN_STATUSES as readonly string[]).includes(value);
}

// Apple-ish soft tones matching src/components/accounts/status.tsx's
// TONE_CLASSNAME palette — kept local since this pill has its own 4-value
// domain (ok/auth_error/rate_limited/sync_error) distinct from AccountStatus.
const STATUS_PILL_CLASS: Record<KnownStatus, string> = {
  ok: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  auth_error: "bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300",
  rate_limited: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  sync_error: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
};
const UNKNOWN_STATUS_PILL_CLASS =
  "bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-300";

// ─── Validation schema ────────────────────────────────────────────────────────

const OWNER_LOGIN_REGEX = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

// Mirrors the server-side schema in
// apps/api/src/trpc/routers/githubDelivery.ts `setConnection` — kept in
// lockstep so a client-side reject always matches what the server would
// also reject, and vice versa.
const schema = z.object({
  ownerLogin: z
    .string()
    .regex(OWNER_LOGIN_REGEX, "Enter a valid GitHub org or user login"),
  token: z
    .string()
    .min(20, "Token looks too short")
    .max(255, "Token looks too long"),
  repoAllowlist: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

const EMPTY_FORM_VALUES: FormValues = { ownerLogin: "", token: "", repoAllowlist: "" };

// Splits the textarea's one-`owner/repo`-per-line input into a trimmed,
// non-empty array — or `undefined` when the field is blank, so an empty
// allowlist round-trips as "all repos" (the server's `.optional()` accepts
// only `undefined`, never `[]`).
function parseAllowlist(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length > 0 ? lines : undefined;
}

// ─── Props ──────────────────────────────────────────────────────────────────

interface Props {
  orgId: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function GithubConnectionSettings({ orgId }: Props) {
  const t = useTranslations("evaluator.githubConnection");
  const tCommon = useTranslations("common");
  const utils = trpc.useUtils();

  const { data, isLoading, error } = trpc.githubDelivery.getConnection.useQuery({
    orgId,
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: useTranslatedZodResolver(schema),
    defaultValues: EMPTY_FORM_VALUES,
  });

  const invalidateConnection = () =>
    utils.githubDelivery.getConnection.invalidate({ orgId });

  function errorToast(err: unknown, fallbackMessage: string) {
    const code = (err as { data?: { code?: string } } | undefined)?.data?.code;
    if (code === "FORBIDDEN") {
      toast.error(tCommon("insufficientPermission"));
    } else {
      toast.error(fallbackMessage);
    }
  }

  const setConnection = trpc.githubDelivery.setConnection.useMutation({
    onSuccess: (result, variables) => {
      toast.success(t("connectedToast", { repo: result.sampleRepo ?? variables.ownerLogin }));
      reset(EMPTY_FORM_VALUES);
      invalidateConnection();
    },
    onError: (err) => {
      const code = (err as { data?: { code?: string } } | undefined)?.data?.code;
      if (code === "BAD_REQUEST") {
        toast.error(`${t("probeFailed")}: ${err.message}`);
      } else {
        errorToast(err, err.message);
      }
    },
  });

  const syncNow = trpc.githubDelivery.syncNow.useMutation({
    onSuccess: () => {
      toast.success(t("syncQueued"));
      invalidateConnection();
    },
    onError: (err) => errorToast(err, err.message),
  });

  const deleteConnection = trpc.githubDelivery.deleteConnection.useMutation({
    onSuccess: () => {
      toast.success(t("deletedToast"));
      invalidateConnection();
    },
    onError: (err) => errorToast(err, err.message),
  });

  const onSubmit = handleSubmit((values) =>
    setConnection.mutateAsync({
      orgId,
      ownerLogin: values.ownerLogin,
      token: values.token,
      repoAllowlist: parseAllowlist(values.repoAllowlist),
    }),
  );

  const handleDelete = () => {
    if (!window.confirm(t("deleteConfirm"))) return;
    deleteConnection.mutate({ orgId });
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground text-center">
          {t("loading")}
        </CardContent>
      </Card>
    );
  }

  if (error) {
    const code = (error.data as { code?: string } | undefined)?.code;
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground text-center">
          {code === "NOT_FOUND" ? t("notEnabled") : error.message}
        </CardContent>
      </Card>
    );
  }

  const connection = data as ConnectionData | null;

  return (
    <div className="space-y-6">
      {connection ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("title")}</CardTitle>
            <CardDescription>{connection.ownerLogin}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("owner")}</span>
              <span className="font-medium">{connection.ownerLogin}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("tokenLabel")}</span>
              <span className="font-mono">{`••••${connection.tokenLast4}`}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("statusLabel")}</span>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ring-transparent",
                  isKnownStatus(connection.status)
                    ? STATUS_PILL_CLASS[connection.status]
                    : UNKNOWN_STATUS_PILL_CLASS,
                )}
              >
                {isKnownStatus(connection.status)
                  ? t(`status.${connection.status}`)
                  : connection.status}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("lastSync")}</span>
              <span>
                {connection.lastSyncAt
                  ? new Date(connection.lastSyncAt).toLocaleString()
                  : t("neverSynced")}
              </span>
            </div>
            {connection.lastSyncError && (
              <div className="space-y-1">
                <span className="text-muted-foreground">{t("lastError")}</span>
                <p
                  className="truncate text-xs text-muted-foreground"
                  title={connection.lastSyncError}
                >
                  {connection.lastSyncError}
                </p>
              </div>
            )}
            <div className="flex items-start justify-between gap-4">
              <span className="text-muted-foreground">{t("allowlistLabel")}</span>
              <span className="text-right">
                {connection.repoAllowlist && connection.repoAllowlist.length > 0
                  ? connection.repoAllowlist.join(", ")
                  : t("allRepos")}
              </span>
            </div>
          </CardContent>
          <CardFooter className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => syncNow.mutate({ orgId })}
              disabled={syncNow.isPending || deleteConnection.isPending}
            >
              {t("syncNowBtn")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              disabled={syncNow.isPending || deleteConnection.isPending}
            >
              {t("deleteBtn")}
            </Button>
          </CardFooter>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">{t("noConnection")}</p>
      )}

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="ghOwnerLogin">{t("owner")}</Label>
          <Input
            id="ghOwnerLogin"
            placeholder="acme"
            autoComplete="off"
            {...register("ownerLogin")}
          />
          {errors.ownerLogin && (
            <p className="text-xs text-destructive">{errors.ownerLogin.message}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ghToken">{t("tokenLabel")}</Label>
          <textarea
            id="ghToken"
            rows={4}
            className={TEXTAREA_CLASS}
            autoComplete="off"
            placeholder="github_pat_…"
            {...register("token")}
          />
          <p className="text-xs text-muted-foreground">{t("tokenHint")}</p>
          {errors.token && (
            <p className="text-xs text-destructive">{errors.token.message}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ghRepoAllowlist">{t("allowlistLabel")}</Label>
          <textarea
            id="ghRepoAllowlist"
            rows={3}
            className={TEXTAREA_CLASS}
            placeholder={"acme/web\nacme/api"}
            {...register("repoAllowlist")}
          />
          {errors.repoAllowlist && (
            <p className="text-xs text-destructive">{errors.repoAllowlist.message}</p>
          )}
        </div>

        <div className="flex justify-end">
          <Button type="submit" disabled={isSubmitting || setConnection.isPending}>
            {t("connectBtn")}
          </Button>
        </div>
      </form>
    </div>
  );
}
