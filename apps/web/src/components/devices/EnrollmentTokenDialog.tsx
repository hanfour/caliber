"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Copy } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Issued {
  token: string;
  expiresAt: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function buildCurl(token: string): string {
  // The daemon redeems the token via POST /v1/devices/enroll. This one-liner
  // is what the user copies onto their machine to enroll without needing the
  // full caliber-agent binary.
  const body = JSON.stringify({
    token,
    hostname: "$(hostname)",
    os: "$(uname -sr)",
    agentVersion: "manual",
  });
  return `curl -sS -X POST -H 'content-type: application/json' \\\n  -d '${body}' \\\n  "$CALIBER_API_BASE/v1/devices/enroll"`;
}

export function EnrollmentTokenDialog({ open, onOpenChange }: Props) {
  const utils = trpc.useUtils();
  const t = useTranslations("devices.enrollmentDialog");
  const tCommon = useTranslations("common");
  const [issued, setIssued] = useState<Issued | null>(null);

  useEffect(() => {
    if (!open) {
      setIssued(null);
    }
  }, [open]);

  const issue = trpc.devices.enrollmentToken.issue.useMutation({
    onSuccess: ({ token, expiresAt }) => {
      setIssued({ token, expiresAt });
      utils.devices.enrollmentToken.listPending.invalidate();
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      toast.error(code === "FORBIDDEN" ? tCommon("insufficientPermission") : e.message);
    },
  });

  const handleCopyToken = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.token);
      toast.success(t("copied"));
    } catch {
      toast.error(t("copyFail"));
    }
  };

  const handleCopyCurl = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(buildCurl(issued.token));
      toast.success(t("copied"));
    } catch {
      toast.error(t("copyFail"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {issued ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("issuedTitle")}</DialogTitle>
              <DialogDescription>{t("issuedDescription")}</DialogDescription>
            </DialogHeader>
            <div className="min-w-0 space-y-4">
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {t("warning", {
                    expiresAt: new Date(issued.expiresAt).toLocaleString(),
                  })}
                </span>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="enrollToken">{t("tokenLabel")}</Label>
                <div className="flex items-stretch gap-2">
                  <code
                    id="enrollToken"
                    className="min-w-0 flex-1 select-all break-all rounded-md border border-input bg-muted/50 px-3 py-2 font-mono text-xs"
                  >
                    {issued.token}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleCopyToken}
                    className="gap-1.5"
                    aria-label={t("copyTokenAriaLabel")}
                  >
                    <Copy className="h-4 w-4" />
                    {tCommon("copy")}
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="enrollCurl">{t("curlLabel")}</Label>
                <div className="flex items-stretch gap-2">
                  <pre
                    id="enrollCurl"
                    className="min-w-0 flex-1 select-all overflow-x-auto rounded-md border border-input bg-muted/50 px-3 py-2 font-mono text-xs"
                  >
                    {buildCurl(issued.token)}
                  </pre>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleCopyCurl}
                    className="gap-1.5"
                    aria-label={t("copyCurlAriaLabel")}
                  >
                    <Copy className="h-4 w-4" />
                    {tCommon("copy")}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("curlHint")}
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                {t("done")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("title")}</DialogTitle>
              <DialogDescription>{t("description")}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                {tCommon("cancel")}
              </Button>
              <Button
                type="button"
                disabled={issue.isPending}
                onClick={() => issue.mutate(undefined)}
              >
                {issue.isPending ? t("issuing") : t("issue")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
