"use client";

import { useTranslations } from "next-intl";
import { UpstreamOwnList } from "@/components/upstreams/UpstreamOwnList";

export default function UpstreamsPage() {
  const t = useTranslations("upstreams");
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">{t("pageTitle")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("pageSubtitle")}</p>
      </div>
      <UpstreamOwnList />
    </div>
  );
}
