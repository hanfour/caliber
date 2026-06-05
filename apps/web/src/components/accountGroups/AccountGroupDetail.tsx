"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ShieldAlert, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { trpc } from "@/lib/trpc/client";
import { usePermissions } from "@/lib/usePermissions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AccountGroupEditForm } from "./AccountGroupEditForm";
import { AccountGroupMembers } from "./AccountGroupMembers";

interface Props {
  orgId: string;
  groupId: string;
}

export function AccountGroupDetail({ orgId, groupId }: Props) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const { can } = usePermissions();
  const t = useTranslations("accountGroups");
  const tDetail = useTranslations("accountGroups.detail");
  const tCommon = useTranslations("common");
  const confirm = useConfirm();
  const {
    data: group,
    isLoading,
    error,
  } = trpc.accountGroups.get.useQuery({ id: groupId });

  const del = trpc.accountGroups.delete.useMutation({
    onSuccess: () => {
      toast.success(t("deletedToast"));
      utils.accountGroups.list.invalidate({ orgId });
      router.push(`/dashboard/organizations/${orgId}/account-groups`);
    },
    onError: (e) => toast.error(e.message),
  });

  const backLink = (
    <Link
      href={`/dashboard/organizations/${orgId}/account-groups`}
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      {tDetail("backToGroups")}
    </Link>
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        {backLink}
        <Card className="shadow-card p-6 text-sm text-muted-foreground">
          {tCommon("loading")}
        </Card>
      </div>
    );
  }

  if (error || !group) {
    const code = (error?.data as { code?: string } | undefined)?.code;
    const isNotFound = !group || code === "NOT_FOUND";
    return (
      <div className="space-y-4">
        {backLink}
        <Card className="shadow-card flex flex-col items-center p-10 text-center">
          <ShieldAlert className="h-6 w-6 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-semibold">
            {isNotFound ? t("groupNotFound") : t("unableToLoad")}
          </h3>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            {isNotFound
              ? t("groupNotFoundDesc")
              : error?.message}
          </p>
        </Card>
      </div>
    );
  }

  const canUpdate = can({
    type: "account_group.update",
    orgId: group.orgId,
    groupId: group.id,
  });
  const canDelete = can({
    type: "account_group.delete",
    orgId: group.orgId,
    groupId: group.id,
  });
  const canManageMembers = can({
    type: "account_group.manage_members",
    orgId: group.orgId,
    groupId: group.id,
  });

  const handleDelete = async () => {
    const ok = await confirm({
      description: tDetail("confirmDelete", { name: group.name }),
      destructive: true,
    });
    if (!ok) return;
    del.mutate({ id: group.id });
  };

  return (
    <div className="space-y-6">
      {backLink}

      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            {group.name}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            <code className="font-mono">{group.platform}</code> · {t("rateLabel", { multiplier: String(group.rateMultiplier) })} · {group.isExclusive ? t("exclusiveLabel") : t("sharedLabel")} ·{" "}
            <span
              className={
                group.status === "active"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground"
              }
            >
              {group.status}
            </span>
          </p>
          {group.description && (
            <p className="mt-2 text-sm">{group.description}</p>
          )}
        </div>
        {canDelete && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-destructive hover:text-destructive"
            onClick={handleDelete}
            disabled={del.isPending}
          >
            <Trash2 className="h-4 w-4" />
            {del.isPending ? tDetail("deletingGroup") : t("deleteGroup")}
          </Button>
        )}
      </div>

      <Card className="shadow-card">
        <CardHeader>
          <CardTitle>{t("membersWithCount", { count: group.members.length })}</CardTitle>
          <CardDescription>
            {t("membersDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canManageMembers ? (
            <AccountGroupMembers orgId={orgId} group={group} />
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("viewMembersOnly")}{" "}
              <code className="font-mono">account_group.manage_members</code>.
            </p>
          )}
        </CardContent>
      </Card>

      {canUpdate && (
        <Card className="shadow-card">
          <CardHeader>
            <CardTitle>{tDetail("settingsTitle")}</CardTitle>
            <CardDescription>
              {tDetail("settingsDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AccountGroupEditForm orgId={orgId} group={group} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
