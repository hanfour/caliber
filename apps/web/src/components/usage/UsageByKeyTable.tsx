"use client";

import { useTranslations } from "next-intl";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@caliber/api-types";
import { formatUsd } from "@/lib/money";

type ByKeyRow =
  inferRouterOutputs<AppRouter>["usage"]["summary"]["byKey"][number];

function fmtNum(n: number): string {
  return n.toLocaleString();
}

/**
 * Per-API-key usage breakdown table (1 key ≈ 1 project for BYOK users).
 * Shared by the member status page (showOwner=false) and the admin org usage
 * page (showOwner=true). Cost is $0 for OAuth/subscription-routed keys — only
 * metered pool-API-key usage carries a non-zero cost.
 */
export function UsageByKeyTable({
  rows,
  showOwner,
}: {
  rows: ByKeyRow[];
  showOwner: boolean;
}) {
  const t = useTranslations("usage.byKey");
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("empty")}</p>;
  }
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-0 text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
            <th scope="col" className="px-3 py-2 text-left font-medium">{t("colKey")}</th>
            {showOwner && (
              <th scope="col" className="px-3 py-2 text-left font-medium">{t("colOwner")}</th>
            )}
            <th scope="col" className="px-3 py-2 text-right font-medium">{t("colRequests")}</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">{t("colInput")}</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">{t("colOutput")}</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">{t("colCacheWrite")}</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">{t("colCacheRead")}</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">{t("colCost")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.apiKeyId ?? "none"} className="border-b border-border last:border-0">
              <td className="px-3 py-2 text-xs">{r.keyName ?? t("unknownKey")}</td>
              {showOwner && (
                <td className="px-3 py-2 text-xs text-muted-foreground">{r.ownerEmail ?? "—"}</td>
              )}
              <td className="px-3 py-2 text-right text-xs">{fmtNum(r.requests)}</td>
              <td className="px-3 py-2 text-right font-mono text-xs">{fmtNum(r.inputTokens)}</td>
              <td className="px-3 py-2 text-right font-mono text-xs">{fmtNum(r.outputTokens)}</td>
              <td className="px-3 py-2 text-right font-mono text-xs">{fmtNum(r.cacheCreationTokens)}</td>
              <td className="px-3 py-2 text-right font-mono text-xs">{fmtNum(r.cacheReadTokens)}</td>
              <td className="px-3 py-2 text-right font-mono text-xs">{formatUsd(r.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
