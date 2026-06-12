"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@caliber/api-types";
import { trpc } from "@/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { deriveAccountStatus, StatusBadge } from "@/components/accounts/status";
import { ExpiryCountdown } from "./ExpiryCountdown";

type UpstreamRow = inferRouterOutputs<AppRouter>["accounts"]["listOwn"][number];

export function CredentialHealthSection() {
  const t = useTranslations("status.health");
  const tCommon = useTranslations("common");
  const { data, isLoading, error } = trpc.accounts.listOwn.useQuery();

  return (
    <Card className="shadow-card">
      <CardHeader className="space-y-0">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">{t("description")}</p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{tCommon("loading")}</p>
        ) : error ? (
          <p className="text-xs text-destructive">{t("loadError")}</p>
        ) : !data || data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("empty")}{" "}
            <Link href="/dashboard/upstreams" className="text-primary underline">
              {t("manageLink")}
            </Link>
          </p>
        ) : (
          <>
            {data.some((row: UpstreamRow) => deriveAccountStatus(row) === "credential_invalid") && (
              <p className="mb-3 text-sm text-muted-foreground">
                <Link href="/dashboard/upstreams" className="text-primary underline">
                  {t("credentialInvalidCta")}
                </Link>
              </p>
            )}
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                  <th scope="col" className="px-3 py-2 text-left font-medium">{t("colName")}</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">{t("colStatus")}</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">{t("colExpiry")}</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">{t("colError")}</th>
                </tr>
              </thead>
              <tbody>
                {data.map((row: UpstreamRow) => (
                  <tr key={row.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 font-medium">{row.name}</td>
                    <td className="px-3 py-2"><StatusBadge status={deriveAccountStatus(row)} /></td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      <ExpiryCountdown expiresAt={row.expiresAt} />
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{row.errorMessage ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
