"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { AlertTriangle, Copy } from "lucide-react";
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

// Native select mirroring the shadcn `Input` primitive (no <Select> yet).
const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const schema = z.object({
  name: z.string().min(1, "validation.custom.shared.nameRequired").max(255),
  // Empty string means "— Any team —"; server treats undefined as null.
  teamId: z.string().uuid().optional().or(z.literal("")),
});

type FormValues = z.infer<typeof schema>;

interface Issued {
  revealUrl: string;
  prefix: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  targetUserId: string;
  targetUserLabel: string;
}

export function AdminIssueDialog({
  open,
  onOpenChange,
  orgId,
  targetUserId,
  targetUserLabel,
}: Props) {
  const utils = trpc.useUtils();
  const t = useTranslations("memberApiKeys.adminIssueDialog");
  const tCreate = useTranslations("memberApiKeys.createDialog");
  const tCommon = useTranslations("common");
  // One-time URL lives ONLY in component state — never logged, never echoed
  // through toasts, never placed in a URL query. Matches the self-issue contract.
  const [issued, setIssued] = useState<Issued | null>(null);

  const { data: teams, isLoading: teamsLoading } = trpc.teams.list.useQuery(
    { orgId },
    { enabled: open },
  );

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", teamId: "" },
  });

  // On close (Cancel, X, ESC, click-outside, Done): reset form + issued state
  // so the next open starts clean. No "undo" — a lost URL means re-issue.
  useEffect(() => {
    if (!open) {
      setIssued(null);
      reset({ name: "", teamId: "" });
    }
  }, [open, reset]);

  const issue = trpc.apiKeys.issueForUser.useMutation({
    onSuccess: ({ revealUrl, prefix }) => {
      setIssued({ revealUrl, prefix });
      utils.apiKeys.listOrg.invalidate({ orgId });
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

  const handleCopy = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.revealUrl);
      // Toast omits the URL — treat like a credential-in-transit.
      toast.success(tCreate("copied"));
    } catch {
      toast.error(tCreate("copyFail"));
    }
  };

  const onSubmit = (values: FormValues) => {
    issue.mutate({
      orgId,
      targetUserId,
      name: values.name,
      // undefined (not "") so server nullable().optional() matches self-issue.
      teamId: values.teamId ? values.teamId : undefined,
    });
  };

  const hasTeams = !teamsLoading && !!teams && teams.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {issued ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("issuedTitle")}</DialogTitle>
              <DialogDescription>
                {t("issuedDescription", { target: targetUserLabel })}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {t("warning")}
                </span>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="apiKeyRevealUrl">{t("urlLabel")}</Label>
                <div className="flex items-stretch gap-2">
                  <code
                    id="apiKeyRevealUrl"
                    className="flex-1 select-all break-all rounded-md border border-input bg-muted/50 px-3 py-2 font-mono text-xs"
                  >
                    {issued.revealUrl}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleCopy}
                    className="gap-1.5"
                    aria-label={t("copyUrlAriaLabel")}
                  >
                    <Copy className="h-4 w-4" />
                    {tCommon("copy")}
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {tCreate("prefixLabel")}{" "}
                <code className="font-mono text-foreground">
                  {issued.prefix}
                </code>
              </p>
              <p className="text-xs text-muted-foreground">
                {t("expireNote")}
              </p>
            </div>
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                {tCreate("done")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("title")}</DialogTitle>
              <DialogDescription>
                {t("description", { target: targetUserLabel })}
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="adminApiKeyName">{t("nameLabel")}</Label>
                <Input
                  id="adminApiKeyName"
                  placeholder={t("namePlaceholder")}
                  autoComplete="off"
                  {...register("name")}
                />
                {errors.name && (
                  <p className="text-xs text-destructive">
                    {errors.name.message}
                  </p>
                )}
              </div>
              {(teamsLoading || hasTeams) && (
                <div className="space-y-1.5">
                  <Label htmlFor="adminApiKeyTeamId">{t("teamOptionalLabel")}</Label>
                  <select
                    id="adminApiKeyTeamId"
                    className={SELECT_CLASS}
                    disabled={teamsLoading}
                    {...register("teamId")}
                  >
                    {teamsLoading ? (
                      <option value="">{t("loadingTeams")}</option>
                    ) : (
                      <>
                        <option value="">{t("anyTeam")}</option>
                        {teams?.map((team) => (
                          <option key={team.id} value={team.id}>
                            {team.name}
                          </option>
                        ))}
                      </>
                    )}
                  </select>
                  {errors.teamId && (
                    <p className="text-xs text-destructive">
                      {errors.teamId.message}
                    </p>
                  )}
                </div>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  {tCommon("cancel")}
                </Button>
                <Button type="submit" disabled={issue.isPending}>
                  {issue.isPending ? t("generating") : t("generateUrl")}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
