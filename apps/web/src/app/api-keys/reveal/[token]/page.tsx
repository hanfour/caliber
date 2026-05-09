"use client";

// One-time reveal landing page for admin-issued API keys. Client component
// (not server) because `apiKeys.revealViaToken` is a MUTATION — rendering
// must stay side-effect-free, and we also want the user to log in / confirm
// before the CAS flip. Reveal fires only on explicit button click.

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  KeyRound,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";

type State = "idle" | "revealing" | "revealed" | "error";

// Raw key lives ONLY in component state — never logged, never echoed through
// toasts, never persisted. Navigation drops it; the server CAS has already
// flipped `revealedAt`, so it is unrecoverable.
interface Revealed {
  raw: string;
  prefix: string;
  name: string;
}

const BANNER =
  "flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200";

export default function RevealApiKeyPage() {
  const params = useParams();
  const router = useRouter();
  const t = useTranslations("reveal");
  const tCommon = useTranslations("common");
  const token = params?.token as string;

  const [state, setState] = useState<State>("idle");
  const [result, setResult] = useState<Revealed | null>(null);

  const { data: session, isLoading: sessionLoading } =
    trpc.me.session.useQuery();

  const reveal = trpc.apiKeys.revealViaToken.useMutation({
    onSuccess: ({ raw, prefix, name }) => {
      setResult({ raw, prefix, name: name ?? "" });
      setState("revealed");
    },
    // Server intentionally unifies invalid / mismatched / already-claimed /
    // expired as NOT_FOUND (no existence leak). Do NOT try to distinguish.
    onError: () => setState("error"),
  });

  const handleReveal = () => {
    setState("revealing");
    reveal.mutate({ token });
  };

  const handleCopy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.raw);
      // Toast omits the raw value — treat as a credential in transit.
      toast.success(t("copiedToast"));
    } catch {
      toast.error(t("copyFailToast"));
    }
  };

  if (sessionLoading) {
    return (
      <Shell icon={<KeyRound className="h-6 w-6 text-primary" />}>
        <CardHeader className="text-center">
          <CardTitle>{t("loading")}</CardTitle>
          <CardDescription>{t("checkingSession")}</CardDescription>
        </CardHeader>
      </Shell>
    );
  }

  if (!session?.user) {
    const returnTo = encodeURIComponent(`/api-keys/reveal/${token}`);
    return (
      <Shell icon={<KeyRound className="h-6 w-6 text-primary" />}>
        <CardHeader className="text-center">
          <CardTitle>{t("signInTitle")}</CardTitle>
          <CardDescription>
            {t("signInDesc")}
          </CardDescription>
        </CardHeader>
        <CardFooter className="justify-center">
          <Button onClick={() => router.push(`/sign-in?returnTo=${returnTo}`)}>
            {t("signInBtn")}
          </Button>
        </CardFooter>
      </Shell>
    );
  }

  if (state === "error") {
    return (
      <Shell icon={<XCircle className="h-6 w-6 text-destructive" />}>
        <CardHeader className="text-center">
          <CardTitle>{t("errorTitle")}</CardTitle>
          <CardDescription>
            {t("errorDesc")}
          </CardDescription>
        </CardHeader>
        <CardFooter className="justify-center">
          <Button onClick={() => router.push("/dashboard/profile")}>
            {t("goToProfile")}
          </Button>
        </CardFooter>
      </Shell>
    );
  }

  if (state === "revealed" && result) {
    return (
      <Shell icon={<CheckCircle2 className="h-6 w-6 text-primary" />}>
        <CardHeader className="text-center">
          <CardTitle>{t("yourKey")}</CardTitle>
          {result.name ? (
            <CardDescription>{t("keyName", { name: result.name })}</CardDescription>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-4">
          <div role="alert" className={BANNER}>
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {t("warning")}
            </span>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="apiKeyRaw">{t("keyLabel")}</Label>
            <div className="flex items-stretch gap-2">
              <code
                id="apiKeyRaw"
                className="flex-1 select-all break-all rounded-md border border-input bg-muted/50 px-3 py-2 font-mono text-xs"
              >
                {result.raw}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleCopy}
                className="gap-1.5"
                aria-label={t("copyKeyAriaLabel")}
              >
                <Copy className="h-4 w-4" />
                {tCommon("copy")}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("prefixLabel")}{" "}
            <code className="font-mono text-foreground">{result.prefix}</code>
          </p>
        </CardContent>
        <CardFooter className="justify-center">
          <Button onClick={() => router.push("/dashboard/profile")}>
            {t("doneBtn")}
          </Button>
        </CardFooter>
      </Shell>
    );
  }

  // state === 'idle' | 'revealing' — authenticated, pre-claim view.
  return (
    <Shell icon={<KeyRound className="h-6 w-6 text-primary" />}>
      <CardHeader className="text-center">
        <CardTitle>{t("claimTitle")}</CardTitle>
        <CardDescription>
          {t("claimDesc")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div role="alert" className={BANNER}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {t("claimWarning")}
          </span>
        </div>
      </CardContent>
      <CardFooter className="justify-center">
        <Button
          onClick={handleReveal}
          disabled={state === "revealing"}
          aria-busy={state === "revealing"}
        >
          {state === "revealing" ? t("revealing") : t("revealBtn")}
        </Button>
      </CardFooter>
    </Shell>
  );
}

function Shell({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md shadow-card">
        <div className="mx-auto mt-6 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
          {icon}
        </div>
        {children}
      </Card>
    </main>
  );
}
