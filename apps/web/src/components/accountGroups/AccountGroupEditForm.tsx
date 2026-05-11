"use client";

import { useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@caliber/api-types";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const TEXTAREA_CLASS =
  "flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const schema = z.object({
  name: z.string().min(1, "Name is required").max(255),
  description: z.string().max(10_000).nullable(),
  rateMultiplier: z.coerce.number().positive().max(10000),
  isExclusive: z.boolean(),
  status: z.enum(["active", "disabled"]),
});

type FormValues = z.infer<typeof schema>;

type Group = inferRouterOutputs<AppRouter>["accountGroups"]["get"];

interface Props {
  orgId: string;
  group: Group;
}

export function AccountGroupEditForm({ orgId, group }: Props) {
  const utils = trpc.useUtils();
  const t = useTranslations("accountGroups");
  const tCreate = useTranslations("accountGroups.create");
  const tDetail = useTranslations("accountGroups.detail");
  const tCommon = useTranslations("common");

  const update = trpc.accountGroups.update.useMutation({
    onSuccess: () => {
      toast.success(t("updatedToast"));
      utils.accountGroups.list.invalidate({ orgId });
      utils.accountGroups.get.invalidate({ id: group.id });
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      if (code === "FORBIDDEN") {
        toast.error(tCommon("insufficientPermission"));
      } else if (code === "BAD_REQUEST") {
        toast.error(e.message || tCommon("error"));
      } else {
        toast.error(e.message);
      }
    },
  });

  // Map a group row to form values. Memoised refs are not needed because
  // we re-derive from `group` only on ID change (see effect below) — the
  // function itself stays in the closure.
  const groupToValues = (g: Group): FormValues => ({
    name: g.name,
    description: g.description ?? "",
    rateMultiplier: Number(g.rateMultiplier),
    isExclusive: g.isExclusive,
    status: g.status === "disabled" ? "disabled" : "active",
  });

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting, isDirty },
    reset,
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: groupToValues(group),
  });

  // When the underlying group ID changes (admin navigated to a different
  // group inside the same component instance), reset the form. We
  // intentionally do NOT reset on every prop change so that an
  // `accountGroups.get` invalidation triggered by a sibling component
  // (e.g. AccountGroupMembers updating priorities) won't wipe the
  // admin's mid-form edits — the prior `values:` prop did the latter.
  const lastGroupIdRef = useRef(group.id);
  useEffect(() => {
    if (lastGroupIdRef.current !== group.id) {
      lastGroupIdRef.current = group.id;
      reset(groupToValues(group));
    }
    // groupToValues is closure-stable per render and we explicitly depend
    // only on group.id; eslint can't see the field-narrowing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.id, reset]);

  const onSubmit = handleSubmit(async (v) => {
    await update.mutateAsync({
      id: group.id,
      name: v.name,
      description: v.description === "" ? null : v.description,
      rateMultiplier: v.rateMultiplier,
      isExclusive: v.isExclusive,
      status: v.status,
    });
    // Reset dirty state after successful save so the button disables again.
    reset(v);
  });

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="name">{tCreate("nameLabel")}</Label>
        <Input id="name" {...register("name")} />
        {errors.name && (
          <p className="text-xs text-destructive">{errors.name.message}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="description">{tCreate("descriptionLabel")}</Label>
        <textarea
          id="description"
          rows={2}
          className={TEXTAREA_CLASS}
          {...register("description")}
        />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="rateMultiplier">{tCreate("rateMultiplierLabel")}</Label>
          <Input
            id="rateMultiplier"
            type="number"
            step="0.1"
            min="0"
            {...register("rateMultiplier")}
          />
          {errors.rateMultiplier && (
            <p className="text-xs text-destructive">
              {errors.rateMultiplier.message}
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="status">{t("status")}</Label>
          <select id="status" className={SELECT_CLASS} {...register("status")}>
            <option value="active">{tCommon("active")}</option>
            <option value="disabled">{tCommon("disabled")}</option>
          </select>
        </div>

        <div className="space-y-1.5">
          <Label>{t("exclusive")}</Label>
          <label className="flex items-start gap-2 pt-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              {...register("isExclusive")}
            />
            <span className="text-xs text-muted-foreground">
              {tDetail("membersNotByOthers")}
            </span>
          </label>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {tDetail("platformFixed", { platform: group.platform })}
      </p>

      <div className="flex justify-end pt-1">
        <Button
          type="submit"
          disabled={!isDirty || isSubmitting || update.isPending}
        >
          {update.isPending ? tCommon("saving") : tCommon("saveChanges")}
        </Button>
      </div>
    </form>
  );
}
