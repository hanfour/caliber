"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { useTranslatedZodResolver } from "@/lib/i18n/useTranslatedZodResolver";
import { z } from "zod";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
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

// Mirrors the backend `accounts.update` bounds (name 1-255, priority 0-1000,
// concurrency 1-1000). `schedulable` is a plain boolean toggle. We intentionally
// surface only these four metadata fields — notes/rateMultiplier are optional in
// the mutation, so omitting them leaves the stored values untouched.
const schema = z.object({
  name: z.string().min(1, "validation.custom.shared.nameRequired").max(255),
  priority: z.coerce.number().int().min(0).max(1000),
  concurrency: z.coerce.number().int().min(1).max(1000),
  schedulable: z.boolean(),
});
type FormValues = z.infer<typeof schema>;

/** The editable subset of an account row this dialog operates on. */
export interface EditableAccount {
  id: string;
  name: string;
  priority: number;
  concurrency: number;
  schedulable: boolean;
}

interface EditAccountDialogProps {
  /** Account being edited. Pass null to close. */
  account: EditableAccount | null;
  /** Org id used to invalidate the accounts.list query after success. */
  orgId: string;
  onClose: () => void;
}

/**
 * Edit an admin-managed account's scheduling metadata (issue #209 launch
 * polish). Mirrors the sibling RotateCredentialDialog but targets the
 * org-scoped `accounts.update` mutation (permission `account.update`).
 *
 * Only name / priority / concurrency / schedulable are editable here —
 * credential material is rotated via RotateCredentialDialog, never edited.
 */
export function EditAccountDialog({
  account,
  orgId,
  onClose,
}: EditAccountDialogProps) {
  const utils = trpc.useUtils();
  const t = useTranslations("accounts.editDialog");
  const tCommon = useTranslations("common");

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: useTranslatedZodResolver(schema),
    defaultValues: {
      name: "",
      priority: 50,
      concurrency: 3,
      schedulable: true,
    },
  });

  const open = account !== null;

  // Pre-fill the form whenever a new account opens the dialog, and clear it on
  // close so a reopen doesn't flash stale values.
  useEffect(() => {
    if (account) {
      reset({
        name: account.name,
        priority: account.priority,
        concurrency: account.concurrency,
        schedulable: account.schedulable,
      });
    } else {
      reset({ name: "", priority: 50, concurrency: 3, schedulable: true });
    }
  }, [account, reset]);

  const update = trpc.accounts.update.useMutation({
    onSuccess: () => {
      toast.success(t("updatedToast"));
      utils.accounts.list.invalidate({ orgId });
      onClose();
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      if (code === "FORBIDDEN") {
        toast.error(tCommon("insufficientPermission"));
      } else if (code === "BAD_REQUEST") {
        toast.error(e.message || t("invalidRequest"));
      } else {
        toast.error(e.message);
      }
    },
  });

  const onSubmit = (v: FormValues) => {
    if (!account) return;
    return update.mutateAsync({
      id: account.id,
      name: v.name,
      priority: v.priority,
      concurrency: v.concurrency,
      schedulable: v.schedulable,
    });
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
          <div className="space-y-1.5">
            <Label htmlFor="editName">{t("nameLabel")}</Label>
            <Input
              id="editName"
              autoComplete="off"
              disabled={update.isPending}
              {...register("name")}
            />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name.message}</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="editPriority">{t("priorityLabel")}</Label>
              <Input
                id="editPriority"
                type="number"
                min={0}
                max={1000}
                disabled={update.isPending}
                {...register("priority")}
              />
              {errors.priority && (
                <p className="text-xs text-destructive">
                  {errors.priority.message}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="editConcurrency">{t("concurrencyLabel")}</Label>
              <Input
                id="editConcurrency"
                type="number"
                min={1}
                max={1000}
                disabled={update.isPending}
                {...register("concurrency")}
              />
              {errors.concurrency && (
                <p className="text-xs text-destructive">
                  {errors.concurrency.message}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-start gap-2 text-sm">
            <input
              id="editSchedulable"
              type="checkbox"
              className="mt-0.5"
              disabled={update.isPending}
              {...register("schedulable")}
            />
            <div className="space-y-0.5">
              <Label htmlFor="editSchedulable" className="font-medium">
                {t("schedulableLabel")}
              </Label>
              <span className="block text-xs text-muted-foreground">
                {t("schedulableHint")}
              </span>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={update.isPending}
            >
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {update.isPending ? t("submitting") : tCommon("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
