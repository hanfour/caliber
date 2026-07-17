"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname, useParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { usePermissions } from "@/lib/usePermissions";
import type { Action } from "@caliber/auth/rbac/actions";

interface Tab {
  href: string;
  label: string;
  /**
   * RBAC action that gates the subpage. The tab is hidden when the
   * caller can't perform the action — keeps the nav honest and
   * matches the per-page RequirePerm gate the user would hit anyway
   * on click.
   */
  action: (orgId: string) => Action;
}

const TABS: Tab[] = [
  {
    href: "/status",
    label: "Status",
    action: (orgId) => ({ type: "evaluator.read_status", orgId }),
  },
  {
    href: "/settings",
    label: "Settings",
    action: (orgId) => ({ type: "content_capture.toggle", orgId }),
  },
  {
    href: "/rubrics",
    label: "Rubrics",
    action: (orgId) => ({ type: "rubric.read", orgId }),
  },
  {
    href: "/costs",
    label: "Costs",
    action: (orgId) => ({ type: "evaluator.view_cost", orgId }),
  },
  // Label kept as a literal here to match the other entries above, which are
  // literals too even though `evaluator.tabs.*` i18n keys exist for them —
  // this array is built outside the component (no `useTranslations` access).
  // The locked i18n value is `evaluator.githubConnection.tabLabel` = "GitHub".
  {
    href: "/github",
    label: "GitHub",
    action: (orgId) => ({ type: "github.manage", orgId }),
  },
];

export default function EvaluatorLayout({
  children,
}: {
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const params = useParams();
  const orgId = params?.id as string;
  const { can } = usePermissions();

  const visibleTabs = TABS.filter((t) => can(t.action(orgId)));

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Evaluator</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Inspect captured request bodies, configure capture and LLM
          evaluation, manage rubrics, and review cost.
        </p>
      </div>

      {visibleTabs.length > 0 && (
        <div className="border-b border-border">
          <nav className="flex gap-1 overflow-x-auto">
            {visibleTabs.map((t) => {
              const href = `/dashboard/organizations/${orgId}/evaluator${t.href}`;
              const active = pathname === href;
              return (
                <Link
                  key={t.label}
                  href={href}
                  className={cn(
                    "relative -mb-px border-b-2 px-3 py-2 text-sm transition-colors",
                    active
                      ? "border-primary text-foreground font-medium"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t.label}
                </Link>
              );
            })}
          </nav>
        </div>
      )}

      <div>{children}</div>
    </div>
  );
}
