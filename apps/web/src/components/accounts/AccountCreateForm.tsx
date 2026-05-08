"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Native select/textarea share these classes so they visually match the
// shadcn `Input` primitive — there is no `<Select>` or `<Textarea>` component
// in this app yet (see ui/ directory). Inline-classed natives keep this task
// scoped without inventing new primitives.
const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const TEXTAREA_CLASS =
  "flex w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

function isValidJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

const schema = z
  .object({
    name: z.string().min(1, "Name is required").max(255),
    platform: z.enum(["anthropic", "openai"]),
    type: z.enum(["api_key", "oauth"]),
    scopeType: z.enum(["org", "team"]),
    teamId: z.string().uuid().optional().or(z.literal("")),
    credentials: z.string().min(1, "Credentials are required").max(100_000),
  })
  .refine(
    (v) => v.scopeType === "org" || (v.teamId !== undefined && v.teamId !== ""),
    { message: "Pick a team", path: ["teamId"] },
  )
  .refine((v) => v.type !== "oauth" || isValidJson(v.credentials), {
    message: "OAuth credentials must be valid JSON",
    path: ["credentials"],
  });
// Note: the OpenAI + oauth combo is unreachable through this form — the
// `type=oauth` radio is `disabled={platform === "openai"}` and a
// useEffect below snaps back to api_key if the user picked OAuth first
// then toggled to OpenAI. The backend `accounts.create` mutation still
// accepts the combo for callers that bypass this UI; per the API-key
// migration plan, the OAuth-pool path is intentionally not surfaced
// here.

type FormValues = z.infer<typeof schema>;

interface Props {
  orgId: string;
}

export function AccountCreateForm({ orgId }: Props) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const { data: teams, isLoading: teamsLoading } = trpc.teams.list.useQuery({
    orgId,
  });

  const create = trpc.accounts.create.useMutation({
    onSuccess: (account) => {
      toast.success(`Account "${account?.name}" created`);
      utils.accounts.list.invalidate({ orgId });
      router.push(`/dashboard/organizations/${orgId}/accounts`);
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      if (code === "FORBIDDEN") {
        toast.error("Insufficient permission");
      } else if (code === "BAD_REQUEST") {
        toast.error(e.message || "Invalid request");
      } else {
        toast.error(e.message);
      }
    },
  });

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    clearErrors,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      platform: "anthropic",
      type: "api_key",
      scopeType: "org",
    },
  });

  const type = watch("type");
  const platform = watch("platform");
  const scopeType = watch("scopeType");

  // Clear stale credentials validation error when the user toggles `type`.
  // RHF + zodResolver only revalidates on submit/blur, so an OAuth-JSON error
  // would otherwise persist after switching back to `api_key`.
  useEffect(() => {
    clearErrors("credentials");
  }, [type, clearErrors]);

  // Force `type=api_key` when the user picks OpenAI — OAuth subscription
  // paste is not an exposed onboarding path for OpenAI (see schema
  // refinement). Re-toggling to anthropic restores the user's choice
  // would be nice but adds state; keeping it simple — they re-pick.
  useEffect(() => {
    if (platform === "openai" && type === "oauth") {
      setValue("type", "api_key");
      clearErrors("type");
    }
  }, [platform, type, setValue, clearErrors]);

  // Reset `teamId` when scope toggles back to `org`. RHF retains the value
  // even though the <select> is conditionally unmounted, which is misleading
  // if the user later toggles back to `team`.
  useEffect(() => {
    if (scopeType === "org") {
      setValue("teamId", "");
    }
  }, [scopeType, setValue]);

  const credentialHint =
    type === "oauth"
      ? "Paste the OAuth JSON returned by `claude auth login` — must include `access_token`, `refresh_token`, `expires_at`."
      : platform === "openai"
        ? "Paste the OpenAI org/project API key (sk-... or sk-proj-...). See docs/admin/openai-account-setup.md for sourcing."
        : "Paste the raw Anthropic API key (sk-ant-...).";

  const credentialPlaceholder =
    type === "oauth"
      ? '{"access_token":"...","refresh_token":"...","expires_at":...}'
      : platform === "openai"
        ? "sk-proj-..."
        : "sk-ant-...";

  // Defensive submit-time check (closes #72): RHF's register() attaches
  // its own onChange, but under some click-then-submit-in-same-tick
  // sequences (browser automation, very fast keyboard navigation) the
  // synthetic event ordering can swallow the radio's state update —
  // the DOM shows the new selection but RHF's `v.type` still has the
  // previous value, silently submitting the wrong type. Read the
  // live DOM truth at submit and prefer it over RHF when they
  // disagree.
  //
  // formRef gives us a stable scope to query so we don't pick up
  // hypothetical other `name="type"` radios elsewhere on the page.
  const formRef = useRef<HTMLFormElement | null>(null);

  const readDomCheckedType = (): "api_key" | "oauth" | null => {
    const el = formRef.current?.querySelector<HTMLInputElement>(
      'input[name="type"]:checked',
    );
    const v = el?.value;
    return v === "api_key" || v === "oauth" ? v : null;
  };

  const onSubmit = handleSubmit((v) => {
    const domType = readDomCheckedType();
    const finalType = domType ?? v.type;
    if (domType && domType !== v.type) {
      // Sync RHF for the next render so the UI reflects what we sent.
      setValue("type", domType);
    }
    return create.mutateAsync({
      orgId,
      teamId: v.scopeType === "team" ? v.teamId || undefined : null,
      name: v.name,
      platform: v.platform,
      type: finalType,
      credentials: v.credentials,
    });
  });

  return (
    <form ref={formRef} onSubmit={onSubmit} className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          placeholder="e.g. Production Anthropic key"
          {...register("name")}
        />
        {errors.name && (
          <p className="text-xs text-destructive">{errors.name.message}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="platform">Platform</Label>
        <select
          id="platform"
          className={SELECT_CLASS}
          {...register("platform")}
        >
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
        </select>
        <p className="text-xs text-muted-foreground">
          {platform === "openai"
            ? "Onboard via API key obtained from a compliant OpenAI org / project."
            : "Anthropic supports both API key and OAuth (claude auth login)."}
        </p>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium leading-none">Type</legend>
        <div className="flex flex-col gap-2 pt-1">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              value="api_key"
              className="mt-0.5"
              {...register("type")}
            />
            <span>
              <span className="font-medium">API key</span>
              <span className="block text-xs text-muted-foreground">
                Long-lived Anthropic API key.
              </span>
            </span>
          </label>
          <label
            className={`flex items-start gap-2 text-sm ${platform === "openai" ? "opacity-50" : ""}`}
          >
            <input
              type="radio"
              value="oauth"
              className="mt-0.5"
              disabled={platform === "openai"}
              {...register("type")}
            />
            <span>
              <span className="font-medium">OAuth (JSON)</span>
              <span className="block text-xs text-muted-foreground">
                {platform === "openai"
                  ? "Not available for OpenAI — use API key path."
                  : "Refreshable token bundle from `claude auth login`."}
              </span>
            </span>
          </label>
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium leading-none">Scope</legend>
        <div className="flex flex-col gap-2 pt-1">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              value="org"
              className="mt-0.5"
              {...register("scopeType")}
            />
            <span>
              <span className="font-medium">Organization</span>
              <span className="block text-xs text-muted-foreground">
                Any team in this workspace can use this account.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              value="team"
              className="mt-0.5"
              {...register("scopeType")}
            />
            <span>
              <span className="font-medium">Specific team</span>
              <span className="block text-xs text-muted-foreground">
                Only the selected team can use this account.
              </span>
            </span>
          </label>
        </div>
        {scopeType === "team" && (
          <div className="space-y-1.5 pl-6 pt-1">
            <Label htmlFor="teamId">Team</Label>
            <select
              id="teamId"
              className={SELECT_CLASS}
              disabled={teamsLoading}
              {...register("teamId")}
            >
              {teamsLoading ? (
                <option value="" disabled>
                  Loading teams…
                </option>
              ) : (
                <option value="">— Select a team —</option>
              )}
              {teams?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            {errors.teamId && (
              <p className="text-xs text-destructive">
                {errors.teamId.message}
              </p>
            )}
          </div>
        )}
      </fieldset>

      <div className="space-y-1.5">
        <Label htmlFor="credentials">Credentials</Label>
        <textarea
          id="credentials"
          rows={6}
          className={TEXTAREA_CLASS}
          placeholder={credentialPlaceholder}
          {...register("credentials")}
        />
        <p className="text-xs text-muted-foreground">{credentialHint}</p>
        {errors.credentials && (
          <p className="text-xs text-destructive">
            {errors.credentials.message}
          </p>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" asChild>
          <Link href={`/dashboard/organizations/${orgId}/accounts`}>
            Cancel
          </Link>
        </Button>
        <Button type="submit" disabled={isSubmitting || create.isPending}>
          {create.isPending ? "Creating…" : "Create account"}
        </Button>
      </div>
    </form>
  );
}
