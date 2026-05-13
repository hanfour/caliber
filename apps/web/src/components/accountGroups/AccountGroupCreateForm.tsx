"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const TEXTAREA_CLASS =
  "flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const schema = z.object({
  name: z.string().min(1, "validation.custom.shared.nameRequired").max(255),
  description: z.string().max(10_000).optional().or(z.literal("")),
  platform: z.enum(["anthropic", "openai"]),
  rateMultiplier: z.coerce.number().positive().max(10000),
  isExclusive: z.boolean(),
});

type FormValues = z.infer<typeof schema>;

interface Props {
  orgId: string;
}

export function AccountGroupCreateForm({ orgId }: Props) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const t = useTranslations("accountGroups.create");
  const tGroups = useTranslations("accountGroups");
  const tCommon = useTranslations("common");

  const create = trpc.accountGroups.create.useMutation({
    onSuccess: (group) => {
      toast.success(tGroups("createdToast", { name: group?.name ?? "" }));
      utils.accountGroups.list.invalidate({ orgId });
      router.push(
        `/dashboard/organizations/${orgId}/account-groups/${group.id}`,
      );
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

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      platform: "openai",
      rateMultiplier: 1,
      isExclusive: false,
    },
  });

  const onSubmit = handleSubmit((v) =>
    create.mutateAsync({
      orgId,
      name: v.name,
      description: v.description ? v.description : undefined,
      platform: v.platform,
      rateMultiplier: v.rateMultiplier,
      isExclusive: v.isExclusive,
    }),
  );

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="name">{t("nameLabel")}</Label>
        <Input
          id="name"
          placeholder={t("nameHelpPlaceholder")}
          {...register("name")}
        />
        {errors.name && (
          <p className="text-xs text-destructive">{errors.name.message}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="description">{t("descriptionOptionalLabel")}</Label>
        <textarea
          id="description"
          rows={2}
          className={TEXTAREA_CLASS}
          placeholder={t("descriptionHelpPlaceholder")}
          {...register("description")}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="platform">{t("platformLabel")}</Label>
        <select
          id="platform"
          className={SELECT_CLASS}
          {...register("platform")}
        >
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
        </select>
        <p className="text-xs text-muted-foreground">
          {t("platformAllSamePlatform")}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="rateMultiplier">{t("rateMultiplierLabel")}</Label>
          <Input
            id="rateMultiplier"
            type="number"
            step="0.1"
            min="0"
            {...register("rateMultiplier")}
          />
          <p className="text-xs text-muted-foreground">
            {t("rateMultiplierHint")}
          </p>
          {errors.rateMultiplier && (
            <p className="text-xs text-destructive">
              {errors.rateMultiplier.message}
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="isExclusive">{tGroups("exclusive")}</Label>
          <label className="flex items-start gap-2 pt-2 text-sm">
            <input
              id="isExclusive"
              type="checkbox"
              className="mt-0.5"
              {...register("isExclusive")}
            />
            <span className="text-xs text-muted-foreground">
              {t("exclusiveHint")}
            </span>
          </label>
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" asChild>
          <Link href={`/dashboard/organizations/${orgId}/account-groups`}>
            {tCommon("cancel")}
          </Link>
        </Button>
        <Button type="submit" disabled={isSubmitting || create.isPending}>
          {create.isPending ? t("submitting") : t("submit")}
        </Button>
      </div>
    </form>
  );
}
