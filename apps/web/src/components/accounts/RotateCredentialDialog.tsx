"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { useTranslatedZodResolver } from "@/lib/i18n/useTranslatedZodResolver";
import { z } from "zod";
import { AlertTriangle, Loader2 } from "lucide-react";
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

// Copied from UpstreamRotateDialog — this app has no <Textarea> primitive yet,
// so the native textarea is styled inline to match the Input primitive.
const TEXTAREA_CLASS =
  "flex w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const schema = z.object({
  credentials: z
    .string()
    .min(1, "validation.custom.accounts.credentialsRequired")
    .max(100_000),
});
type FormValues = z.infer<typeof schema>;

interface RotateCredentialDialogProps {
  /** Account being rotated. Pass null to close. */
  account: { id: string; name: string } | null;
  /** Org id used to invalidate the accounts.list query after success. */
  orgId: string;
  onClose: () => void;
}

/**
 * Rotate the stored credential for an admin-managed `api_key` upstream
 * account (issue #203). Mirrors the member-side UpstreamRotateDialog but
 * targets the org-scoped `accounts.rotate` mutation (permission
 * `account.rotate`) and invalidates the org's `accounts.list` on success.
 *
 * OAuth accounts use the Keychain re-onboard flow instead — this dialog is
 * only wired in for `api_key` accounts.
 */
export function RotateCredentialDialog({
  account,
  orgId,
  onClose,
}: RotateCredentialDialogProps) {
  const utils = trpc.useUtils();
  const t = useTranslations("accounts.rotateDialog");
  const tCommon = useTranslations("common");

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: useTranslatedZodResolver(schema),
    defaultValues: { credentials: "" },
  });

  const open = account !== null;
  useEffect(() => {
    if (!open) reset({ credentials: "" });
  }, [open, reset]);

  const rotate = trpc.accounts.rotate.useMutation({
    onSuccess: () => {
      toast.success(t("rotatedToast"));
      utils.accounts.list.invalidate({ orgId });
      reset({ credentials: "" });
      onClose();
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      toast.error(
        code === "FORBIDDEN" ? tCommon("insufficientPermission") : e.message,
      );
    },
  });

  const onSubmit = (v: FormValues) => {
    if (!account) return;
    return rotate.mutateAsync({ id: account.id, credentials: v.credentials });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description", { name: account?.name ?? "" })}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t("warning")}</span>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rotateCred">{t("credentialsLabel")}</Label>
            <textarea
              id="rotateCred"
              rows={5}
              className={TEXTAREA_CLASS}
              autoComplete="off"
              placeholder={t("placeholder")}
              disabled={rotate.isPending}
              {...register("credentials")}
            />
            {errors.credentials && (
              <p className="text-xs text-destructive">
                {errors.credentials.message}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={rotate.isPending}
            >
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={rotate.isPending}>
              {rotate.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {rotate.isPending ? t("submitting") : t("submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
