"use client";

import { useEffect, useState } from "react";
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
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { OAuthConnectWizard } from "./OAuthConnectWizard";

// Copied from AccountCreateForm — the app has no <Select>/<Textarea> primitive yet.
const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";
const TEXTAREA_CLASS =
  "flex w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const schema = z.object({
  name: z.string().min(1, "validation.custom.shared.nameRequired").max(255),
  platform: z.enum(["anthropic", "openai"]),
  credentials: z.string().min(1, "validation.custom.accounts.credentialsRequired").max(100_000),
});
type FormValues = z.infer<typeof schema>;

interface Props { open: boolean; onOpenChange: (open: boolean) => void; }

export function UpstreamRegisterDialog({ open, onOpenChange }: Props) {
  const utils = trpc.useUtils();
  const t = useTranslations("upstreams.registerDialog");
  const tu = useTranslations("upstreams");
  const tCommon = useTranslations("common");

  const { register, handleSubmit, reset, watch, formState: { errors } } = useForm<FormValues>({
    resolver: useTranslatedZodResolver(schema),
    defaultValues: { name: "", platform: "anthropic", credentials: "" },
  });
  const platform = watch("platform");
  const [method, setMethod] = useState<"api_key" | "oauth">("api_key");

  useEffect(() => {
    if (!open) {
      reset({ name: "", platform: "anthropic", credentials: "" });
      setMethod("api_key");
    }
  }, [open, reset]);

  const registerOwn = trpc.accounts.registerOwn.useMutation({
    onSuccess: () => {
      toast.success(t("createdToast"));
      utils.accounts.listOwn.invalidate();
      onOpenChange(false);
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      toast.error(code === "FORBIDDEN" ? tCommon("insufficientPermission") : e.message);
    },
  });

  const onSubmit = (v: FormValues) =>
    registerOwn.mutateAsync({ name: v.name, platform: v.platform, type: "api_key", credentials: v.credentials });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="upName">{t("nameLabel")}</Label>
            <Input id="upName" placeholder={t("namePlaceholder")} autoComplete="off" {...register("name")} />
            {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="upPlatform">{t("platformLabel")}</Label>
            <select id="upPlatform" className={SELECT_CLASS} {...register("platform")}>
              <option value="anthropic">{tu("platformAnthropic")}</option>
              <option value="openai">{tu("platformOpenAI")}</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="upMethod">{tu("oauth.method")}</Label>
            <select
              id="upMethod"
              className={SELECT_CLASS}
              value={method}
              onChange={(e) => setMethod(e.target.value as "api_key" | "oauth")}
            >
              <option value="api_key">{tu("oauth.methodApiKey")}</option>
              <option value="oauth">{tu("oauth.methodOAuth")}</option>
            </select>
          </div>
          {method === "oauth" ? (
            <OAuthConnectWizard
              platform={platform as "openai" | "anthropic"}
              onDone={() => {
                utils.accounts.listOwn.invalidate();
                onOpenChange(false);
              }}
            />
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="upCred">{t("credentialsLabel")}</Label>
                <textarea
                  id="upCred" rows={6} className={TEXTAREA_CLASS} autoComplete="off"
                  placeholder={platform === "openai" ? "sk-proj-…" : "sk-ant-…"}
                  {...register("credentials")}
                />
                <p className="text-xs text-muted-foreground">
                  {platform === "openai" ? t("credentialsHintOpenAI") : t("credentialsHintAnthropic")}
                </p>
                {errors.credentials && <p className="text-xs text-destructive">{errors.credentials.message}</p>}
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tCommon("cancel")}</Button>
                <Button type="submit" disabled={registerOwn.isPending}>
                  {registerOwn.isPending ? t("submitting") : t("submit")}
                </Button>
              </DialogFooter>
            </>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
