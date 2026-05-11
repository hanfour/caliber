"use client";

import Link from "next/link";
import { useState } from "react";
import {
  MoreHorizontal,
  Key,
  Plus,
  ShieldAlert,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@caliber/api-types";
import { trpc } from "@/lib/trpc/client";
import { formatRelative } from "@/lib/time";
import { usePermissions } from "@/lib/usePermissions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge, deriveAccountStatus } from "./status";
import { ReonboardDialog } from "./ReonboardDialog";

type AccountRow = inferRouterOutputs<AppRouter>["accounts"]["list"][number];

interface AccountRowActionsProps {
  row: AccountRow;
  orgId: string;
  onDelete: (row: AccountRow) => void;
  onReonboard: (row: AccountRow) => void;
  isDeleting: boolean;
}

function AccountRowActions({
  row,
  orgId,
  onDelete,
  onReonboard,
  isDeleting,
}: AccountRowActionsProps) {
  const { can } = usePermissions();
  const t = useTranslations("accounts");
  const tCommon = useTranslations("common");
  const canRotate = can({ type: "account.rotate", orgId, accountId: row.id });
  const canUpdate = can({ type: "account.update", orgId, accountId: row.id });
  const canDelete = can({ type: "account.delete", orgId, accountId: row.id });
  const canReonboard = canRotate && row.type === "oauth";

  // If the caller has no row-level actions at all, render nothing rather than
  // a dead trigger.
  if (!canRotate && !canUpdate && !canDelete) return null;

  const handleDelete = () => {
    if (typeof window === "undefined") return;
    const ok = window.confirm(t("confirmDelete", { name: row.name }));
    if (!ok) return;
    onDelete(row);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          aria-label={t("actionsAriaLabel", { name: row.name })}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/* Re-onboard (OAuth-only): rotates a fresh Keychain bundle in *and*
            resets failure state so the scheduler picks the account back up.
            Use this when invalid_grant has auto-paused the account or just
            to refresh expiring credentials. */}
        {canReonboard && (
          <DropdownMenuItem onSelect={() => onReonboard(row)}>
            <Key className="h-4 w-4" />
            {t("reonboardFromKeychain")}
          </DropdownMenuItem>
        )}
        {/* Rotate + Edit flows land in a follow-up PR. Kept disabled here so
            the eventual affordance has a stable slot and permissioned admins
            can see the feature is planned (rather than a toast that reads as
            user error). */}
        {canRotate && row.type !== "oauth" && (
          <DropdownMenuItem disabled>
            <Key className="h-4 w-4" />
            {t("rotateCredentials")}
            <span className="ml-auto text-[10px] text-muted-foreground">
              {tCommon("comingSoon")}
            </span>
          </DropdownMenuItem>
        )}
        {canUpdate && (
          <DropdownMenuItem disabled>
            {tCommon("edit")}
            <span className="ml-auto text-[10px] text-muted-foreground">
              {tCommon("comingSoon")}
            </span>
          </DropdownMenuItem>
        )}
        {canDelete && (
          <>
            {(canRotate || canUpdate) && <DropdownMenuSeparator />}
            <DropdownMenuItem
              onSelect={handleDelete}
              disabled={isDeleting}
              className="text-destructive focus:text-destructive"
            >
              {isDeleting ? tCommon("deleting") : tCommon("delete")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface AccountListProps {
  orgId: string;
}

export function AccountList({ orgId }: AccountListProps) {
  const utils = trpc.useUtils();
  const { can } = usePermissions();
  const t = useTranslations("accounts");
  const tCommon = useTranslations("common");
  const canCreate = can({ type: "account.create", orgId, teamId: null });
  const {
    data: accounts,
    isLoading,
    error,
  } = trpc.accounts.list.useQuery({ orgId });
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [reonboardingAccount, setReonboardingAccount] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const del = trpc.accounts.delete.useMutation({
    onSuccess: () => {
      toast.success(t("removedToast"));
      utils.accounts.list.invalidate({ orgId });
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      toast.error(code === "FORBIDDEN" ? tCommon("insufficientPermission") : e.message);
    },
    onSettled: () => {
      setDeletingId(null);
    },
  });

  const handleDelete = (row: AccountRow) => {
    setDeletingId(row.id);
    del.mutate({ id: row.id });
  };

  const newAccountHref = `/dashboard/organizations/${orgId}/accounts/new`;

  const headerCta = canCreate ? (
    <div className="flex justify-end">
      <Button size="sm" className="gap-1.5" asChild>
        <Link href={newAccountHref}>
          <Plus className="h-4 w-4" />
          {t("newAccount")}
        </Link>
      </Button>
    </div>
  ) : null;

  if (isLoading) {
    return (
      <div className="space-y-4">
        {headerCta}
        <Card className="shadow-card p-6 text-sm text-muted-foreground">
          {tCommon("loading")}
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        {headerCta}
        <Card className="shadow-card flex flex-col items-center p-10 text-center">
          <ShieldAlert className="h-6 w-6 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-semibold">
            {t("unableToLoad")}
          </h3>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            {error.message}
          </p>
        </Card>
      </div>
    );
  }

  if (!accounts || accounts.length === 0) {
    return (
      <div className="space-y-4">
        {headerCta}
        <Card className="shadow-card flex flex-col items-center p-10 text-center">
          <Key className="h-6 w-6 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-semibold">
            {t("emptyTitle")}
          </h3>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            {t("emptyHint")}
          </p>
          {canCreate && (
            <Button size="sm" className="mt-4 gap-1.5" asChild>
              <Link href={newAccountHref}>
                <Plus className="h-4 w-4" />
                {t("newAccount")}
              </Link>
            </Button>
          )}
        </Card>
      </div>
    );
  }

  // Issue #92 sub-task 2: surface accounts auto-paused by
  // `oauth_invalid_grant`. The refresh_token rotated externally
  // (Claude Code app, another caliber instance, …) and caliber can no
  // longer refresh on its own. Direct operator to re-onboard from
  // Keychain instead of leaving the account silently dead.
  const invalidGrantAccounts = accounts.filter(
    (r) => r.tempUnschedulableReason === "oauth_invalid_grant",
  );

  return (
    <div className="space-y-4">
      {headerCta}
      {invalidGrantAccounts.length > 0 && (
        <Card className="shadow-card border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-700/60 dark:bg-amber-950/40">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 flex-none text-amber-600 dark:text-amber-400" />
            <div className="flex-1 space-y-2">
              <div className="space-y-1">
                <p className="font-semibold text-amber-900 dark:text-amber-200">
                  {invalidGrantAccounts.length === 1
                    ? t("reonboardSingleTitle", { name: invalidGrantAccounts[0]!.name })
                    : t("reonboardMultiTitle", { count: invalidGrantAccounts.length })}
                </p>
                <p className="text-xs text-amber-800/80 dark:text-amber-200/80">
                  {t("reonboardWarningBody")}
                </p>
              </div>
              {invalidGrantAccounts.length === 1 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="border-amber-400 bg-amber-100/40 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/30 dark:hover:bg-amber-900/40"
                  onClick={() =>
                    setReonboardingAccount({
                      id: invalidGrantAccounts[0]!.id,
                      name: invalidGrantAccounts[0]!.name,
                    })
                  }
                >
                  {t("reonboardFromKeychain")}
                </Button>
              )}
            </div>
          </div>
        </Card>
      )}
      <Card className="shadow-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
              <th scope="col" className="px-4 py-2 text-left font-medium">
                {t("name")}
              </th>
              <th scope="col" className="px-4 py-2 text-left font-medium">
                {t("platform")}
              </th>
              <th scope="col" className="px-4 py-2 text-left font-medium">
                {t("type")}
              </th>
              <th scope="col" className="px-4 py-2 text-left font-medium">
                {t("status")}
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium">
                {t("priority")}
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium">
                {t("concurrency")}
              </th>
              <th scope="col" className="px-4 py-2 text-left font-medium">
                {t("lastUsed")}
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((row) => {
              const status = deriveAccountStatus(row);
              const lastUsedTitle = row.lastUsedAt
                ? new Date(row.lastUsedAt).toLocaleString()
                : undefined;
              return (
                <tr
                  key={row.id}
                  className="border-b border-border last:border-0 hover:bg-accent/20"
                >
                  <td className="px-4 py-2.5 font-medium">{row.name}</td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {row.platform}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {row.type === "oauth" ? t("typeOauth") : t("typeApiKey")}
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={status} />
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {row.priority}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {row.concurrency}
                  </td>
                  <td
                    className="px-4 py-2.5 text-xs text-muted-foreground"
                    title={lastUsedTitle}
                  >
                    {formatRelative(row.lastUsedAt)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <AccountRowActions
                      row={row}
                      orgId={orgId}
                      onDelete={handleDelete}
                      onReonboard={(r) =>
                        setReonboardingAccount({ id: r.id, name: r.name })
                      }
                      isDeleting={deletingId === row.id}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      <ReonboardDialog
        account={reonboardingAccount}
        orgId={orgId}
        onClose={() => setReonboardingAccount(null)}
      />
    </div>
  );
}
