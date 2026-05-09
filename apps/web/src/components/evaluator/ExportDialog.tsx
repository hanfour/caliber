"use client";

import { useState } from "react";
import { AlertTriangle, Download } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ExportDialog({ open, onOpenChange }: Props) {
  const [loading, setLoading] = useState(false);
  const utils = trpc.useUtils();
  const t = useTranslations("evaluator.exportDialog");
  const tCommon = useTranslations("common");

  const handleDownload = async () => {
    try {
      setLoading(true);
      const data = await utils.reports.exportOwn.fetch();

      // Create blob and trigger download
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `evaluation-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);

      toast.success(t("downloadedToast"));
      onOpenChange(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t("exportFailed");
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Warning banner */}
          <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/30 dark:bg-amber-900/20">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                {t("warningTitle")}
              </p>
              <p className="text-xs text-amber-800 dark:text-amber-300 mt-0.5">
                {t("warningDesc")}
              </p>
            </div>
          </div>

          {/* What's included / not included */}
          <div className="space-y-3">
            <div>
              <p className="text-sm font-semibold text-foreground mb-2">
                {t("includedHeading")}
              </p>
              <ul className="text-xs text-muted-foreground space-y-1 ml-4">
                <li>• {t("included1")}</li>
                <li>• {t("included2")}</li>
                <li>
                  • {t("included3")}
                </li>
              </ul>
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground mb-2">
                {t("notIncludedHeading")}
              </p>
              <ul className="text-xs text-muted-foreground space-y-1 ml-4">
                <li>• {t("notIncluded1")}</li>
                <li className="text-[11px]">
                  {t("notIncluded2")}
                </li>
              </ul>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            {tCommon("cancel")}
          </Button>
          <Button
            onClick={handleDownload}
            disabled={loading}
            className="gap-2"
          >
            {loading ? (
              <>
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                {t("exporting")}
              </>
            ) : (
              <>
                <Download className="h-4 w-4" />
                {t("downloadBtn")}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
