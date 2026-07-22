"use client";

import { useState } from "react";
import { Plus, Pencil, RefreshCw, Trash2, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@caliber/api-types";
import { trpc } from "@/lib/trpc/client";
import { toDate } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { deriveAccountStatus, StatusBadge } from "@/components/accounts/status";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { UpstreamRegisterDialog } from "./UpstreamRegisterDialog";
import { UpstreamEditDialog } from "./UpstreamEditDialog";
import { UpstreamRotateDialog } from "./UpstreamRotateDialog";
import { OAuthConnectWizard } from "./OAuthConnectWizard";

type UpstreamRow = inferRouterOutputs<AppRouter>["accounts"]["listOwn"][number];

function formatCreated(ts: Date | string | null): string {
  const d = toDate(ts);
  return d ? d.toLocaleDateString() : "—";
}

export function UpstreamOwnList() {
  const utils = trpc.useUtils();
  const t = useTranslations("upstreams");
  const tCommon = useTranslations("common");
  const confirm = useConfirm();
  const [registerOpen, setRegisterOpen] = useState(false);
  const [editRow, setEditRow] = useState<UpstreamRow | null>(null);
  const [rotateRow, setRotateRow] = useState<UpstreamRow | null>(null);
  const [reauthRow, setReauthRow] = useState<UpstreamRow | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const { data, isLoading, error } = trpc.accounts.listOwn.useQuery();

  const del = trpc.accounts.deleteOwn.useMutation({
    onSuccess: () => {
      toast.success(t("deletedToast"));
      utils.accounts.listOwn.invalidate();
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      toast.error(code === "FORBIDDEN" ? tCommon("insufficientPermission") : e.message);
    },
    onSettled: () => setDeletingId(null),
  });

  const handleDelete = async (row: UpstreamRow) => {
    const ok = await confirm({ description: t("confirmDelete", { name: row.name }), destructive: true });
    if (!ok) return;
    setDeletingId(row.id);
    del.mutate({ id: row.id });
  };

  return (
    <Card className="shadow-card">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => setRegisterOpen(true)}>
          <Plus className="h-4 w-4" />
          {t("register")}
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{tCommon("loading")}</p>
        ) : error ? (
          <p className="text-xs text-destructive">{error.message}</p>
        ) : !data || data.length === 0 ? (
          <div className="flex flex-col items-center py-6 text-center">
            <KeyRound className="h-5 w-5 text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">{t("noneHint")}</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                  <th scope="col" className="px-3 py-2 text-left font-medium">{t("colName")}</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">{t("colPlatform")}</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">{t("colType")}</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">{t("colStatus")}</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">{t("colPriority")}</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">{t("colCreated")}</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {data.map((row) => {
                  const isApiKey = row.type === "api_key";
                  return (
                    <tr key={row.id} className="border-b border-border last:border-0 hover:bg-accent/20">
                      <td className="px-3 py-2 font-medium">{row.name}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{row.platform}</td>
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{row.type}</td>
                      <td className="px-3 py-2"><StatusBadge status={deriveAccountStatus(row)} /></td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{row.priority}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{formatCreated(row.createdAt)}</td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setEditRow(row)} aria-label={t("editAriaLabel", { name: row.name })}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          {isApiKey && (
                            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setRotateRow(row)} aria-label={t("rotateAriaLabel", { name: row.name })}>
                              <RefreshCw className="h-4 w-4" />
                            </Button>
                          )}
                          {/* Re-authorize is available for ANY own OAuth upstream, not
                              only expired/error ones: a member may want to proactively
                              refresh a still-working authorization (re-consent, scope
                              change, or a credential misbehaving before its status
                              flips) without deleting and re-creating the upstream. The
                              wizard re-runs the OAuth flow against the SAME upstream id,
                              so an active credential is simply refreshed in place. */}
                          {row.type === "oauth" &&
                            (row.platform === "openai" || row.platform === "anthropic") && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0"
                                onClick={() => setReauthRow(row)}
                                aria-label={t("oauth.reauthAriaLabel", { name: row.name })}
                              >
                                <RefreshCw className="h-4 w-4" />
                              </Button>
                            )}
                          <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive hover:text-destructive" onClick={() => handleDelete(row)} disabled={deletingId === row.id} aria-label={t("deleteAriaLabel", { name: row.name })}>
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
        )}
      </CardContent>
      <UpstreamRegisterDialog open={registerOpen} onOpenChange={setRegisterOpen} />
      <UpstreamEditDialog open={editRow !== null} account={editRow} onOpenChange={(o) => !o && setEditRow(null)} />
      <UpstreamRotateDialog open={rotateRow !== null} account={rotateRow} onOpenChange={(o) => !o && setRotateRow(null)} />
      <Dialog open={reauthRow !== null} onOpenChange={(o) => !o && setReauthRow(null)}>
        <DialogContent>
          {reauthRow && (
            <>
              <DialogHeader>
                <DialogTitle>{t("oauth.reauthTitle", { name: reauthRow.name })}</DialogTitle>
              </DialogHeader>
              <OAuthConnectWizard
                platform={reauthRow.platform as "openai" | "anthropic"}
                targetUpstreamId={reauthRow.id}
                onDone={() => { utils.accounts.listOwn.invalidate(); setReauthRow(null); }}
              />
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
