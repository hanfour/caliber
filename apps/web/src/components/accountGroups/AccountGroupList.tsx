"use client";

import Link from "next/link";
import { useState } from "react";
import {
  MoreHorizontal,
  Layers,
  Plus,
  ShieldAlert,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@caliber/api-types";
import { trpc } from "@/lib/trpc/client";
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

type GroupRow = inferRouterOutputs<AppRouter>["accountGroups"]["list"][number];

interface RowActionsProps {
  row: GroupRow;
  orgId: string;
  onDelete: (row: GroupRow) => void;
  isDeleting: boolean;
}

function GroupRowActions({
  row,
  orgId,
  onDelete,
  isDeleting,
}: RowActionsProps) {
  const { can } = usePermissions();
  const t = useTranslations("accountGroups");
  const tCommon = useTranslations("common");
  const canUpdate = can({
    type: "account_group.update",
    orgId,
    groupId: row.id,
  });
  const canDelete = can({
    type: "account_group.delete",
    orgId,
    groupId: row.id,
  });
  if (!canUpdate && !canDelete) return null;

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
        {canUpdate && (
          <DropdownMenuItem asChild>
            <Link
              href={`/dashboard/organizations/${orgId}/account-groups/${row.id}`}
            >
              {t("editAndManage")}
            </Link>
          </DropdownMenuItem>
        )}
        {canDelete && (
          <>
            {canUpdate && <DropdownMenuSeparator />}
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

interface Props {
  orgId: string;
}

export function AccountGroupList({ orgId }: Props) {
  const utils = trpc.useUtils();
  const { can } = usePermissions();
  const t = useTranslations("accountGroups");
  const tCommon = useTranslations("common");
  const canCreate = can({ type: "account_group.create", orgId });
  const {
    data: groups,
    isLoading,
    error,
  } = trpc.accountGroups.list.useQuery({ orgId });
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const del = trpc.accountGroups.delete.useMutation({
    onSuccess: () => {
      toast.success(t("removedToast"));
      utils.accountGroups.list.invalidate({ orgId });
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      toast.error(code === "FORBIDDEN" ? tCommon("insufficientPermission") : e.message);
    },
    onSettled: () => setDeletingId(null),
  });

  const handleDelete = (row: GroupRow) => {
    setDeletingId(row.id);
    del.mutate({ id: row.id });
  };

  const newHref = `/dashboard/organizations/${orgId}/account-groups/new`;

  const headerCta = canCreate ? (
    <div className="flex justify-end">
      <Button size="sm" className="gap-1.5" asChild>
        <Link href={newHref}>
          <Plus className="h-4 w-4" />
          {t("newGroup")}
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
          <h3 className="mt-3 text-sm font-semibold">{t("unableToLoad")}</h3>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            {error.message}
          </p>
        </Card>
      </div>
    );
  }

  if (!groups || groups.length === 0) {
    return (
      <div className="space-y-4">
        {headerCta}
        <Card className="shadow-card flex flex-col items-center p-10 text-center">
          <Layers className="h-6 w-6 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-semibold">{t("emptyTitle")}</h3>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            {t("emptyDesc")}
          </p>
          {canCreate && (
            <Button size="sm" className="mt-4 gap-1.5" asChild>
              <Link href={newHref}>
                <Plus className="h-4 w-4" />
                {t("newGroup")}
              </Link>
            </Button>
          )}
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {headerCta}
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
              <th scope="col" className="px-4 py-2 text-right font-medium">
                {t("rateMultiplier")}
              </th>
              <th scope="col" className="px-4 py-2 text-left font-medium">
                {t("exclusive")}
              </th>
              <th scope="col" className="px-4 py-2 text-left font-medium">
                {t("status")}
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium" />
            </tr>
          </thead>
          <tbody>
            {groups.map((row) => (
              <tr
                key={row.id}
                className="border-b border-border last:border-0 hover:bg-accent/20"
              >
                <td className="px-4 py-2.5 font-medium">
                  <Link
                    href={`/dashboard/organizations/${orgId}/account-groups/${row.id}`}
                    className="inline-flex items-center gap-1 hover:underline"
                  >
                    {row.name}
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  </Link>
                  {row.description && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {row.description}
                    </p>
                  )}
                </td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground">
                  {row.platform}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-xs">
                  {row.rateMultiplier}
                </td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground">
                  {row.isExclusive ? t("exclusiveYes") : t("exclusiveNo")}
                </td>
                <td className="px-4 py-2.5 text-xs">
                  <span
                    className={
                      row.status === "active"
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-muted-foreground"
                    }
                  >
                    {row.status}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <GroupRowActions
                    row={row}
                    orgId={orgId}
                    onDelete={handleDelete}
                    isDeleting={deletingId === row.id}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
