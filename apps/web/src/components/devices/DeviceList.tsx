"use client";

import { useState } from "react";
import { Plus, Trash2, Laptop } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@caliber/api-types";
import { trpc } from "@/lib/trpc/client";
import { toDate, formatRelative } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EnrollmentTokenDialog } from "./EnrollmentTokenDialog";

type DeviceRow = inferRouterOutputs<AppRouter>["devices"]["listOwn"][number];

function formatEnrolled(ts: Date | string | null): string {
  const d = toDate(ts);
  if (!d) return "—";
  return d.toLocaleDateString();
}

function StatusBadge({ status, activeLabel }: { status: string; activeLabel: string }) {
  const isActive = status === "active";
  return (
    <Badge
      variant="outline"
      className={
        isActive
          ? "border-transparent bg-emerald-100 font-medium text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300"
          : "border-transparent bg-slate-100 font-medium text-slate-700 dark:bg-slate-500/15 dark:text-slate-300"
      }
    >
      {isActive ? activeLabel : status}
    </Badge>
  );
}

export function DeviceList() {
  const utils = trpc.useUtils();
  const t = useTranslations("devices");
  const tCommon = useTranslations("common");
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const { data: devices, isLoading, error } = trpc.devices.listOwn.useQuery();

  const revoke = trpc.devices.revoke.useMutation({
    onSuccess: () => {
      toast.success(t("revokedToast"));
      utils.devices.listOwn.invalidate();
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      toast.error(code === "FORBIDDEN" ? tCommon("insufficientPermission") : e.message);
    },
    onSettled: () => {
      setRevokingId(null);
    },
  });

  const handleRevoke = async (row: DeviceRow) => {
    const ok = await confirm({
      description: t("confirmRevoke", { name: row.hostname }),
      destructive: true,
    });
    if (!ok) return;
    setRevokingId(row.id);
    revoke.mutate({ id: row.id });
  };

  return (
    <Card className="shadow-card">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" />
          {t("newEnrollment")}
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{tCommon("loading")}</p>
        ) : error ? (
          <p className="text-xs text-destructive">{error.message}</p>
        ) : !devices || devices.length === 0 ? (
          <div className="flex flex-col items-center py-6 text-center">
            <Laptop className="h-5 w-5 text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">
              {t("noDevicesHint")}
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    {t("hostname")}
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    {t("os")}
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    {t("agentVersion")}
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    {t("status")}
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    {t("enrolled")}
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    {t("lastSeen")}
                  </th>
                  <th
                    scope="col"
                    className="px-3 py-2 text-right font-medium"
                  ></th>
                </tr>
              </thead>
              <tbody>
                {devices.map((row) => {
                  const lastSeenTitle = row.lastSeenAt
                    ? new Date(row.lastSeenAt).toLocaleString()
                    : undefined;
                  const isRevoking = revokingId === row.id;
                  return (
                    <tr
                      key={row.id}
                      className="border-b border-border last:border-0 hover:bg-accent/20"
                    >
                      <td className="px-3 py-2 font-medium">{row.hostname}</td>
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                        {row.os}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                        {row.agentVersion}
                      </td>
                      <td className="px-3 py-2">
                        <StatusBadge status={row.status} activeLabel={t("statusActive")} />
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {formatEnrolled(row.enrolledAt)}
                      </td>
                      <td
                        className="px-3 py-2 text-xs text-muted-foreground"
                        title={lastSeenTitle}
                      >
                        {formatRelative(row.lastSeenAt)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                          onClick={() => handleRevoke(row)}
                          disabled={isRevoking}
                          aria-label={t("revokeAriaLabel", { name: row.hostname })}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
      <EnrollmentTokenDialog open={open} onOpenChange={setOpen} />
    </Card>
  );
}
