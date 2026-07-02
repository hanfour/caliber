"use client";

import { useState } from "react";
import { KeyRound, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@caliber/api-types";
import { trpc } from "@/lib/trpc/client";
import { usePermissions } from "@/lib/usePermissions";
import { formatRelative, toDate } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  adminStatusClassName,
  deriveAdminKeyStatus,
  type AdminKeyStatus,
} from "./adminStatus";
import { RubricEditor } from "@/components/evaluator/RubricEditor";

type AdminKeyRow = inferRouterOutputs<AppRouter>["apiKeys"]["listOrg"][number];

const STATUS_LABEL_KEY: Record<AdminKeyStatus, string> = {
  active: "statusActive",
  pending_reveal: "statusPendingReveal",
  reveal_expired: "statusRevealExpired",
  claimed: "statusClaimed",
};

function formatCreated(ts: Date | string | null): string {
  const d = toDate(ts);
  if (!d) return "—";
  return d.toLocaleDateString();
}

interface Props {
  orgId: string;
  targetUserId: string;
}

export function AdminApiKeyList({ orgId, targetUserId }: Props) {
  const utils = trpc.useUtils();
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [rubricKeyId, setRubricKeyId] = useState<string | null>(null);
  const t = useTranslations("memberApiKeys");
  const tApiKeys = useTranslations("apiKeys");
  const tKeyScope = useTranslations("evaluator.rubrics.keyScope");
  const tCommon = useTranslations("common");
  const confirm = useConfirm();
  const { can } = usePermissions();
  const {
    data: keys,
    isLoading,
    error,
  } = trpc.apiKeys.listOrg.useQuery({ orgId, userId: targetUserId });

  const setEvaluateAsProject = trpc.apiKeys.setEvaluateAsProject.useMutation({
    onSuccess: (_data, variables) => {
      toast.success(
        variables.enabled
          ? tApiKeys("evaluateAsProject.enabledToast")
          : tApiKeys("evaluateAsProject.disabledToast"),
      );
      utils.apiKeys.listOrg.invalidate({ orgId, userId: targetUserId });
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      toast.error(
        code === "FORBIDDEN"
          ? tCommon("insufficientPermission")
          : tApiKeys("evaluateAsProject.errorToast"),
      );
    },
  });

  const revoke = trpc.apiKeys.revoke.useMutation({
    onSuccess: () => {
      toast.success(t("revokedToast"));
      utils.apiKeys.listOrg.invalidate({ orgId, userId: targetUserId });
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      toast.error(
        code === "FORBIDDEN" ? tCommon("insufficientPermission") : e.message,
      );
    },
    onSettled: () => setRevokingId(null),
  });

  const deleteForKey = trpc.rubrics.deleteForKey.useMutation({
    onSuccess: () => {
      toast.success(tKeyScope("removedToast"));
      utils.apiKeys.listOrg.invalidate({ orgId, userId: targetUserId });
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      toast.error(
        code === "FORBIDDEN" ? tCommon("insufficientPermission") : e.message,
      );
    },
  });

  const handleRevoke = async (row: AdminKeyRow) => {
    const ok = await confirm({
      description: t("confirmRevoke", { name: row.name }),
      destructive: true,
    });
    if (!ok) return;
    setRevokingId(row.id);
    revoke.mutate({ id: row.id });
  };

  const handleRemoveRubric = async (row: AdminKeyRow) => {
    const ok = await confirm({
      description: tKeyScope("confirmRemove", { name: row.name }),
      destructive: true,
    });
    if (!ok) return;
    deleteForKey.mutate({ apiKeyId: row.id });
  };

  if (isLoading) {
    return (
      <p className="text-sm text-muted-foreground">{tCommon("loading")}</p>
    );
  }
  if (error) {
    return <p className="text-xs text-destructive">{error.message}</p>;
  }

  // Server-side filtered by `userId` so an admin browsing one member's keys
  // doesn't receive metadata (names / prefixes / timestamps) for unrelated
  // org members. Kept the nominal safety-net filter below in case the server
  // ever returns an unrelated row — not expected, but cheap.
  const rows = (keys ?? []).filter((r) => r.userId === targetUserId);
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center py-6 text-center">
        <KeyRound className="h-5 w-5 text-muted-foreground" />
        <p className="mt-2 text-sm text-muted-foreground">
          {t("noKeysForUser")}
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
              <th scope="col" className="px-3 py-2 text-left font-medium">
                {t("name")}
              </th>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                {t("prefix")}
              </th>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                {t("status")}
              </th>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                {t("created")}
              </th>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                {t("lastUsed")}
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-center font-medium"
                title={tApiKeys("evaluateAsProject.helperText")}
              >
                {tApiKeys("evaluateAsProject.label")}
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const status = deriveAdminKeyStatus(row);
              const lastUsedTitle = row.lastUsedAt
                ? new Date(row.lastUsedAt).toLocaleString()
                : undefined;
              const isRevoking = revokingId === row.id;
              const canAuthorRubric =
                row.evaluateAsProject &&
                can({
                  type: "rubric.author_key",
                  apiKeyId: row.id,
                  orgId,
                  ownerUserId: row.userId,
                });
              return (
                <tr
                  key={row.id}
                  className="border-b border-border last:border-0 hover:bg-accent/20"
                >
                  <td className="px-3 py-2 font-medium">{row.name}</td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {row.prefix}
                  </td>
                  <td className="px-3 py-2">
                    <Badge
                      variant="outline"
                      className={adminStatusClassName(status)}
                    >
                      {t(STATUS_LABEL_KEY[status])}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {formatCreated(row.createdAt)}
                  </td>
                  <td
                    className="px-3 py-2 text-xs text-muted-foreground"
                    title={lastUsedTitle}
                  >
                    {formatRelative(row.lastUsedAt)}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <input
                      type="checkbox"
                      className="h-4 w-4 cursor-pointer accent-primary"
                      checked={row.evaluateAsProject}
                      disabled={setEvaluateAsProject.isPending}
                      title={tApiKeys("evaluateAsProject.helperText")}
                      aria-label={tApiKeys("evaluateAsProject.ariaLabel", {
                        name: row.name,
                      })}
                      onChange={(e) =>
                        setEvaluateAsProject.mutate({
                          id: row.id,
                          enabled: e.target.checked,
                        })
                      }
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {canAuthorRubric && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 text-xs"
                            onClick={() => setRubricKeyId(row.id)}
                          >
                            {tKeyScope("editButton")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 text-xs text-muted-foreground hover:text-destructive"
                            onClick={() => handleRemoveRubric(row)}
                            disabled={deleteForKey.isPending}
                          >
                            {tKeyScope("removeButton")}
                          </Button>
                        </>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                        onClick={() => handleRevoke(row)}
                        disabled={isRevoking}
                        aria-label={t("revokeAriaLabel", { name: row.name })}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rubricKeyId && (
        <RubricEditor
          target={{ scope: "key", apiKeyId: rubricKeyId, orgId }}
          onSuccess={() => {
            setRubricKeyId(null);
            utils.apiKeys.listOrg.invalidate({ orgId, userId: targetUserId });
          }}
          onCancel={() => setRubricKeyId(null)}
        />
      )}
    </>
  );
}
