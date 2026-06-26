"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { useTranslatedZodResolver } from "@/lib/i18n/useTranslatedZodResolver";
import { z } from "zod";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

const schema = z.object({
  name: z.string().min(1, "validation.custom.shared.nameRequired").max(255),
  schedulable: z.boolean(),
  priority: z.coerce.number().int().min(0).max(1000),
  concurrency: z.coerce.number().int().min(1).max(1000),
});
type FormValues = z.infer<typeof schema>;

interface AccountLike { id: string; name: string; schedulable: boolean; priority: number; concurrency: number; }
interface Props { open: boolean; account: AccountLike | null; onOpenChange: (open: boolean) => void; }

export function UpstreamEditDialog({ open, account, onOpenChange }: Props) {
  const utils = trpc.useUtils();
  const t = useTranslations("upstreams.editDialog");
  const tCommon = useTranslations("common");

  const { register, handleSubmit, reset, formState: { errors } } = useForm<FormValues>({
    resolver: useTranslatedZodResolver(schema),
    defaultValues: { name: "", schedulable: true, priority: 50, concurrency: 20 },
  });

  useEffect(() => {
    if (open && account) reset({ name: account.name, schedulable: account.schedulable, priority: account.priority, concurrency: account.concurrency });
  }, [open, account, reset]);

  const updateOwn = trpc.accounts.updateOwn.useMutation({
    onSuccess: () => {
      toast.success(t("savedToast"));
      utils.accounts.listOwn.invalidate();
      onOpenChange(false);
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      toast.error(code === "FORBIDDEN" ? tCommon("insufficientPermission") : e.message);
    },
  });

  const onSubmit = (v: FormValues) =>
    updateOwn.mutateAsync({ id: account!.id, name: v.name, schedulable: v.schedulable, priority: v.priority, concurrency: v.concurrency });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t("title")}</DialogTitle></DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="edName">{t("nameLabel")}</Label>
            <Input id="edName" {...register("name")} />
            {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" {...register("schedulable")} />
            <span>{t("schedulableLabel")}</span>
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="edPriority">{t("priorityLabel")}</Label>
            <Input id="edPriority" type="number" min={0} max={1000} {...register("priority")} />
            {errors.priority && <p className="text-xs text-destructive">{errors.priority.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edConcurrency">{t("concurrencyLabel")}</Label>
            <Input id="edConcurrency" type="number" min={1} max={1000} {...register("concurrency")} />
            <p className="text-xs text-muted-foreground">{t("concurrencyHint")}</p>
            {errors.concurrency && <p className="text-xs text-destructive">{errors.concurrency.message}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tCommon("cancel")}</Button>
            <Button type="submit" disabled={updateOwn.isPending}>
              {updateOwn.isPending ? t("submitting") : t("submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
