"use client";

// Session-gated device-code approval for `caliber login` (CLI). Client
// component (not server) because `approve`/`deny` are MUTATIONS — rendering
// must stay side-effect-free; they fire only on explicit button click.
// Mirrors apps/web/src/app/api-keys/reveal/[token]/page.tsx: same
// sessionLoading -> sign-in-gate -> action shell.

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, Laptop, ShieldAlert, XCircle } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Decision = "none" | "approved" | "denied" | "error";

export function DeviceApproval() {
  const t = useTranslations("deviceApproval");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialCode = searchParams.get("code") ?? "";

  // Security M1: `POST /v1/device-auth/start` is unauthenticated, so a
  // `?code=` link is fully attacker-shareable (classic RFC 8628 device-code
  // phishing) — an attacker runs `caliber login` on their own machine and
  // mails the victim the resulting link. `submitted` gates the lookup query
  // and MUST default to false even when a code arrives via ?code=: we only
  // pre-fill the input so the member doesn't have to retype it, but the
  // lookup (and therefore the attacker-controlled hostname/os in the
  // consent screen) never fires until the member explicitly clicks
  // Continue. Auto-firing on mount would remove the one confirmation step
  // standing between a phishing link and enrollment into the victim's org.
  const [userCode, setUserCode] = useState(initialCode);
  const [submitted, setSubmitted] = useState(false);
  const [decision, setDecision] = useState<Decision>("none");

  const { data: session, isLoading: sessionLoading } =
    trpc.me.session.useQuery();

  const lookup = trpc.devices.deviceAuth.lookup.useQuery(
    { userCode },
    { enabled: submitted && userCode.length > 0 },
  );

  const approve = trpc.devices.deviceAuth.approve.useMutation({
    onSuccess: () => setDecision("approved"),
    // A code that expired between lookup and click, or was already decided
    // in another tab, fails here — surface it instead of silently resetting
    // isPending with no feedback. The server unifies these as NOT_FOUND, so
    // reuse the same "invalid or expired" copy as the lookup-error branch.
    onError: () => setDecision("error"),
  });
  const deny = trpc.devices.deviceAuth.deny.useMutation({
    onSuccess: () => setDecision("denied"),
    onError: () => setDecision("error"),
  });

  if (sessionLoading) {
    return (
      <Shell icon={<Laptop className="h-6 w-6 text-primary" />}>
        <CardHeader className="text-center">
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
      </Shell>
    );
  }

  if (!session?.user) {
    // sign-in/page.tsx only reads `callbackUrl` (default `/dashboard`) and
    // passes it straight to `signIn(..., { redirectTo })`, so that's the
    // param we must use for the post-auth redirect to land back here.
    // Derived from the SSR-safe next/navigation hooks (not `window.location`)
    // so this branch has no client-only hazard.
    const qs = searchParams.toString();
    const currentPath = qs ? `${pathname}?${qs}` : pathname;
    const callbackUrl = encodeURIComponent(currentPath);
    return (
      <Shell icon={<Laptop className="h-6 w-6 text-primary" />}>
        <CardHeader className="text-center">
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("signInPrompt")}</CardDescription>
        </CardHeader>
        <CardFooter className="justify-center">
          <Button
            onClick={() => router.push(`/sign-in?callbackUrl=${callbackUrl}`)}
          >
            {t("signInCta")}
          </Button>
        </CardFooter>
      </Shell>
    );
  }

  if (decision === "approved") {
    return (
      <Shell icon={<CheckCircle2 className="h-6 w-6 text-primary" />}>
        <CardHeader className="text-center">
          <CardTitle>{t("approved")}</CardTitle>
        </CardHeader>
      </Shell>
    );
  }

  if (decision === "denied") {
    return (
      <Shell icon={<XCircle className="h-6 w-6 text-destructive" />}>
        <CardHeader className="text-center">
          <CardTitle>{t("denied")}</CardTitle>
        </CardHeader>
      </Shell>
    );
  }

  if (decision === "error") {
    return (
      <Shell icon={<ShieldAlert className="h-6 w-6 text-destructive" />}>
        <CardHeader className="text-center">
          <CardTitle>{t("notFound")}</CardTitle>
        </CardHeader>
      </Shell>
    );
  }

  if (!submitted) {
    return (
      <Shell icon={<Laptop className="h-6 w-6 text-primary" />}>
        <CardHeader className="text-center">
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          <Label htmlFor="deviceUserCode">{t("codeLabel")}</Label>
          <Input
            id="deviceUserCode"
            value={userCode}
            placeholder={t("codePlaceholder")}
            onChange={(e) => setUserCode(e.target.value)}
          />
        </CardContent>
        <CardFooter className="justify-center">
          <Button
            disabled={userCode.trim().length === 0}
            onClick={() => setSubmitted(true)}
          >
            {t("lookupCta")}
          </Button>
        </CardFooter>
      </Shell>
    );
  }

  if (lookup.error) {
    return (
      <Shell icon={<ShieldAlert className="h-6 w-6 text-destructive" />}>
        <CardHeader className="text-center">
          <CardTitle>{t("notFound")}</CardTitle>
        </CardHeader>
      </Shell>
    );
  }

  if (lookup.isLoading || !lookup.data) {
    return (
      <Shell icon={<Laptop className="h-6 w-6 text-primary" />}>
        <CardHeader className="text-center">
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
      </Shell>
    );
  }

  const { hostname, os } = lookup.data;

  return (
    <Shell icon={<Laptop className="h-6 w-6 text-primary" />}>
      <CardHeader className="text-center">
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("subtitle", { hostname })}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-center text-sm text-muted-foreground">
          {t("deviceInfo", { hostname, os })}
        </p>
        <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <p className="text-sm font-medium text-destructive">
            {t("phishingWarning")}
          </p>
        </div>
        <div className="space-y-1.5 rounded-md border border-input bg-muted/50 p-3">
          <h3 className="text-sm font-medium">{t("consentHeading")}</h3>
          <p className="text-sm text-muted-foreground">{t("consentBody")}</p>
        </div>
      </CardContent>
      <CardFooter className="justify-center gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={deny.isPending}
          onClick={() => deny.mutate({ userCode })}
        >
          {t("deny")}
        </Button>
        <Button
          type="button"
          disabled={approve.isPending}
          onClick={() => approve.mutate({ userCode })}
        >
          {t("approve")}
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
    <Card className="w-full max-w-md shadow-card">
      <div className="mx-auto mt-6 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
        {icon}
      </div>
      {children}
    </Card>
  );
}
