"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// A small model-selection surface for one replay. Implemented with the
// existing Dialog primitive rather than a new Radix Popover dependency — no
// popover component exists anywhere in this design system yet
// (apps/web/src/components/ui has no popover.tsx), and every comparable
// "pick a few fields, then fire one mutation" flow in this codebase already
// uses Dialog (AdminIssueDialog, ApiKeyCreateDialog, UpstreamRegisterDialog).
// The brief's word "popover" describes the UX weight (small, focused, not a
// full page) — Dialog delivers that without introducing a new primitive for
// a single call site.
interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  orgIdentifier: string;
  requestId: string;
  sourceModel: string;
}

export function ReplayDialog({
  open,
  onOpenChange,
  orgId,
  orgIdentifier,
  requestId,
  sourceModel,
}: Props) {
  const router = useRouter();
  const t = useTranslations("requests.dialog");
  const tCommon = useTranslations("common");
  const [targetModel, setTargetModel] = useState("");

  // Reset on every open so a previous run's typed model never leaks into the
  // next request's dialog.
  useEffect(() => {
    if (open) setTargetModel("");
  }, [open]);

  const enqueue = trpc.replay.enqueue.useMutation({
    onSuccess: () => {
      onOpenChange(false);
      // Task 11 owns the comparison page at this route; Task 10's contract
      // (single-request-replay brief, Step 3) is only to navigate here on a
      // successful enqueue.
      router.push(
        `/dashboard/organizations/${orgIdentifier}/requests/${requestId}`,
      );
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      if (code === "TOO_MANY_REQUESTS") {
        toast.error(e.message);
      } else if (code === "PRECONDITION_FAILED") {
        toast.error(e.message);
      } else if (code === "FORBIDDEN") {
        toast.error(tCommon("insufficientPermission"));
      } else {
        toast.error(e.message || tCommon("error"));
      }
    },
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const model = targetModel.trim();
    if (!model) return;
    enqueue.mutate({ orgId, requestId, targetModel: model });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="replayTargetModel">{t("modelLabel")}</Label>
            <Input
              id="replayTargetModel"
              autoComplete="off"
              placeholder={t("modelPlaceholder")}
              value={targetModel}
              onChange={(e) => setTargetModel(e.target.value)}
              list="replay-model-suggestions"
            />
            {/* Not a catalog constraint (replay.enqueue deliberately accepts
                any bounded string — the gateway resolves aliases and owns
                that list) — just a convenience suggestion so the operator
                isn't stuck guessing an exact model id from scratch. */}
            <datalist id="replay-model-suggestions">
              <option value={sourceModel} />
            </datalist>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {tCommon("cancel")}
            </Button>
            <Button
              type="submit"
              disabled={enqueue.isPending || targetModel.trim().length === 0}
            >
              {enqueue.isPending ? t("submitting") : t("submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
