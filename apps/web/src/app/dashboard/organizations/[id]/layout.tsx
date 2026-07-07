"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname, useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc/client";

interface Tab {
  href: string;
  // Key under the `organizations.tabs` i18n namespace — resolved with the
  // useTranslations hook below so the tab bar follows the active locale.
  labelKey: string;
  visible: (p: {
    isSuperAdmin: boolean;
    isOrgAdmin: boolean;
    hasDeptOrTeamMgr: boolean;
  }) => boolean;
}

export default function OrganizationLayout({
  children,
}: {
  children: ReactNode;
}) {
  const t = useTranslations("organizations");
  const pathname = usePathname() ?? "";
  const params = useParams();
  // The url param can be a slug OR a UUID. Resolve to the canonical org once
  // here (mirrors the #202 accounts-page fix) so the breadcrumb, the
  // permission checks (scopeId is a UUID), and the tab links all work on both
  // /organizations/<slug> and /organizations/<uuid>.
  const identifier = params?.id as string;
  const { data: org } = trpc.organizations.resolveIdentifier.useQuery(
    { identifier },
    { enabled: !!identifier },
  );
  const orgId = org?.id;
  const { data: session } = trpc.me.session.useQuery();

  const isSuperAdmin =
    session?.assignments.some(
      (a: { role: string }) => a.role === "super_admin",
    ) ?? false;
  const isOrgAdmin =
    session?.assignments.some(
      (a: { role: string; scopeType: string; scopeId: string | null }) =>
        a.role === "org_admin" &&
        a.scopeType === "organization" &&
        a.scopeId === orgId,
    ) ?? false;
  const hasDeptOrTeamMgr =
    session?.assignments.some(
      (a: { role: string }) =>
        a.role === "dept_manager" || a.role === "team_manager",
    ) ?? false;

  const tabs: Tab[] = [
    { href: "", labelKey: "tabs.overview", visible: () => true },
    { href: "/departments", labelKey: "tabs.departments", visible: () => true },
    { href: "/teams", labelKey: "tabs.teams", visible: () => true },
    {
      href: "/members",
      labelKey: "tabs.members",
      visible: (p) => p.isSuperAdmin || p.isOrgAdmin || p.hasDeptOrTeamMgr,
    },
    {
      href: "/invites",
      labelKey: "tabs.invites",
      visible: (p) => p.isSuperAdmin || p.isOrgAdmin,
    },
    {
      href: "/accounts",
      labelKey: "tabs.accounts",
      visible: (p) => p.isSuperAdmin || p.isOrgAdmin,
    },
    {
      href: "/account-groups",
      labelKey: "tabs.accountGroups",
      visible: (p) => p.isSuperAdmin || p.isOrgAdmin,
    },
    {
      href: "/usage",
      labelKey: "tabs.usage",
      visible: (p) => p.isSuperAdmin || p.isOrgAdmin,
    },
    {
      href: "/sessions",
      labelKey: "tabs.sessions",
      visible: (p) => p.isSuperAdmin || p.isOrgAdmin,
    },
    {
      href: "/evaluator/status",
      labelKey: "tabs.evaluator",
      visible: (p) => p.isSuperAdmin || p.isOrgAdmin,
    },
    {
      href: "/audit",
      labelKey: "tabs.audit",
      visible: (p) => p.isSuperAdmin || p.isOrgAdmin,
    },
  ];

  const perm = { isSuperAdmin, isOrgAdmin, hasDeptOrTeamMgr };

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary font-semibold">
            {org?.name.charAt(0).toUpperCase() ?? "…"}
          </div>
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">
              {org?.name ?? "Organization"}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              /{org?.slug ?? "…"}
            </p>
          </div>
        </div>
      </div>

      <div className="border-b border-border">
        <nav className="flex gap-1 overflow-x-auto">
          {tabs
            .filter((tab) => tab.visible(perm))
            .map((tab) => {
              const href = `/dashboard/organizations/${identifier}${tab.href}`;
              const active =
                pathname === href ||
                (tab.href === "" &&
                  pathname === `/dashboard/organizations/${identifier}`);
              return (
                <Link
                  key={tab.labelKey}
                  href={href}
                  className={cn(
                    "relative -mb-px border-b-2 px-3 py-2 text-sm transition-colors",
                    active
                      ? "border-primary text-foreground font-medium"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(tab.labelKey)}
                </Link>
              );
            })}
        </nav>
      </div>

      <div>{children}</div>
    </div>
  );
}
