"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";

interface Props {
  platform: "openai" | "anthropic";
  /** Present => re-authorize an existing oauth upstream instead of creating one. */
  targetUpstreamId?: string;
  /** Called after a successful connect (caller closes + invalidates listOwn). */
  onDone: () => void;
}

export function OAuthConnectWizard({ platform, targetUpstreamId, onDone }: Props) {
  const t = useTranslations("upstreams.oauth");
  const tCommon = useTranslations("common");
  const [flowId, setFlowId] = useState<string | null>(null);
  const [pastedValue, setPastedValue] = useState("");

  const initiate = trpc.accounts.initiateOAuth.useMutation({
    onSuccess: (res) => {
      setFlowId(res.flowId);
      window.open(res.authUrl, "_blank", "noopener,noreferrer");
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      toast.error(code === "NOT_FOUND" ? t("anthropicDisabled") : e.message);
    },
  });

  const complete = trpc.accounts.completeOAuth.useMutation({
    onSuccess: () => {
      toast.success(t("connectedToast"));
      onDone();
    },
    onError: (e) => toast.error(e.message),
  });

  if (flowId === null) {
    return (
      <Button
        onClick={() => initiate.mutate({ platform, targetUpstreamId })}
        disabled={initiate.isPending}
      >
        {t("connect")}
      </Button>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {platform === "anthropic" ? t("pasteHintAnthropic") : t("pasteHintOpenAI")}
      </p>
      <textarea
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        rows={3}
        aria-label={t("codeLabel")}
        value={pastedValue}
        onChange={(e) => setPastedValue(e.target.value)}
      />
      <Button
        onClick={() => complete.mutate({ flowId, pastedValue })}
        disabled={complete.isPending || pastedValue.trim() === ""}
      >
        {complete.isPending ? tCommon("loading") : t("submit")}
      </Button>
    </div>
  );
}
