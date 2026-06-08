"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { useTranslatedZodResolver } from "@/lib/i18n/useTranslatedZodResolver";
import { z } from "zod";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

// Copied from AccountCreateForm — this app has no <Textarea> primitive yet,
// so the native textarea is styled inline to match the Input primitive.
const TEXTAREA_CLASS =
  "flex w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const schema = z.object({
  credentials: z.string().min(1, "validation.custom.accounts.credentialsRequired").max(100_000),
});
type FormValues = z.infer<typeof schema>;

interface AccountLike { id: string; name: string; }
interface Props { open: boolean; account: AccountLike | null; onOpenChange: (open: boolean) => void; }

export function UpstreamRotateDialog({ open, account, onOpenChange }: Props) {
  const utils = trpc.useUtils();
  const t = useTranslations("upstreams.rotateDialog");
  const tCommon = useTranslations("common");

  const { register, handleSubmit, reset, formState: { errors } } = useForm<FormValues>({
    resolver: useTranslatedZodResolver(schema),
    defaultValues: { credentials: "" },
  });

  useEffect(() => { if (!open) reset({ credentials: "" }); }, [open, reset]);

  const rotateOwn = trpc.accounts.rotateOwn.useMutation({
    onSuccess: () => {
      toast.success(t("rotatedToast"));
      utils.accounts.listOwn.invalidate();
      onOpenChange(false);
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      toast.error(code === "FORBIDDEN" ? tCommon("insufficientPermission") : e.message);
    },
  });

  const onSubmit = (v: FormValues) => rotateOwn.mutateAsync({ id: account!.id, credentials: v.credentials });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description", { name: account?.name ?? "" })}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div role="alert" className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t("warning")}</span>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rotCred">{t("credentialsLabel")}</Label>
            <textarea id="rotCred" rows={5} className={TEXTAREA_CLASS} autoComplete="off" {...register("credentials")} />
            {errors.credentials && <p className="text-xs text-destructive">{errors.credentials.message}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tCommon("cancel")}</Button>
            <Button type="submit" disabled={rotateOwn.isPending}>
              {rotateOwn.isPending ? t("submitting") : t("submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
