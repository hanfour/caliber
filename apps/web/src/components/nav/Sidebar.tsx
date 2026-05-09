'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  LayoutDashboard,
  Building2,
  Users,
  UserPlus,
  FileText,
  UserCircle
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { trpc } from '@/lib/trpc/client'

interface Perm {
  hasOrg: boolean
  hasTeam: boolean
  hasOrgAdmin: boolean
  hasSuperAdmin: boolean
}

interface SessionLike {
  coveredOrgs: string[]
}

type NavItemKey =
  | 'dashboard' | 'organizations' | 'teams' | 'invites' | 'auditLog' | 'profile'

interface NavItem {
  href: string | ((p: Perm, session: SessionLike | undefined) => string | null)
  // Translation key under `nav.items.*` — resolved at render time so the
  // label updates when the user switches locales.
  labelKey: NavItemKey
  icon: React.ComponentType<{ className?: string }>
  visible: (p: Perm) => boolean
}

interface NavSection {
  // Translation key under `nav.sections.*`.
  titleKey: 'overview' | 'workspace' | 'account'
  items: NavItem[]
}

// `/dashboard/invites` and `/dashboard/audit` don't exist as top-level
// pages — only the org-scoped variants under
// `/dashboard/organizations/[id]/{invites,audit}` are wired. Until a
// multi-org top-level view is built, link directly to the first covered
// org so the sidebar entry actually leads somewhere instead of 404.
function firstOrgHref(suffix: string) {
  return (_p: Perm, session: SessionLike | undefined): string | null => {
    const orgId = session?.coveredOrgs[0]
    return orgId ? `/dashboard/organizations/${orgId}/${suffix}` : null
  }
}

const SECTIONS: NavSection[] = [
  {
    titleKey: 'overview',
    items: [
      { href: '/dashboard', labelKey: 'dashboard', icon: LayoutDashboard, visible: () => true }
    ]
  },
  {
    titleKey: 'workspace',
    items: [
      { href: '/dashboard/organizations', labelKey: 'organizations', icon: Building2, visible: (p) => p.hasOrg },
      { href: '/dashboard/teams', labelKey: 'teams', icon: Users, visible: (p) => p.hasTeam },
      { href: firstOrgHref('invites'), labelKey: 'invites', icon: UserPlus, visible: (p) => p.hasOrgAdmin },
      { href: firstOrgHref('audit'), labelKey: 'auditLog', icon: FileText, visible: (p) => p.hasOrgAdmin }
    ]
  },
  {
    titleKey: 'account',
    items: [
      { href: '/dashboard/profile', labelKey: 'profile', icon: UserCircle, visible: () => true }
    ]
  }
]

export function Sidebar() {
  const pathname = usePathname()
  const { data: session } = trpc.me.session.useQuery()
  const tSections = useTranslations('nav.sections')
  const tItems = useTranslations('nav.items')

  const perm: Perm = {
    hasOrg: (session?.coveredOrgs.length ?? 0) > 0,
    hasTeam: (session?.coveredTeams.length ?? 0) > 0,
    hasOrgAdmin:
      session?.assignments.some(
        (a: { role: string }) => a.role === 'org_admin' || a.role === 'super_admin'
      ) ?? false,
    hasSuperAdmin:
      session?.assignments.some((a: { role: string }) => a.role === 'super_admin') ?? false
  }

  return (
    <aside className="w-60 shrink-0 border-r border-border bg-card/40">
      <div className="flex h-full flex-col">
        <div className="flex h-14 items-center border-b border-border px-5">
          <Link href="/dashboard" className="flex items-center gap-2.5 font-semibold">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-sm text-primary-foreground shadow-card">
              C
            </div>
            <span className="text-[15px] tracking-tight">Caliber</span>
          </Link>
        </div>
        <nav className="flex-1 overflow-y-auto p-3">
          {SECTIONS.map((section) => {
            // Resolve dynamic hrefs first; items returning `null` are
            // hidden (e.g. Invites/Audit when the user has no covered
            // org yet — the link target wouldn't exist).
            const resolved = section.items
              .filter((i) => i.visible(perm))
              .map((i) => {
                const href = typeof i.href === 'function' ? i.href(perm, session) : i.href
                return href ? { ...i, href } : null
              })
              .filter((x): x is NavItem & { href: string } => x !== null)
            if (resolved.length === 0) return null
            return (
              <div key={section.titleKey} className="mb-4">
                <div className="mb-1.5 px-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {tSections(section.titleKey)}
                </div>
                <div className="space-y-0.5">
                  {resolved.map((item) => {
                    const Icon = item.icon
                    const active =
                      pathname === item.href ||
                      (item.href !== '/dashboard' && pathname?.startsWith(item.href + '/')) ||
                      false
                    return (
                      <Link
                        key={item.labelKey}
                        href={item.href}
                        className={cn(
                          'flex items-center gap-3 rounded-lg px-3 py-1.5 text-sm transition-colors',
                          active
                            ? 'bg-accent text-accent-foreground font-medium'
                            : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground'
                        )}
                      >
                        <Icon className="h-4 w-4" />
                        {tItems(item.labelKey)}
                      </Link>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </nav>
      </div>
    </aside>
  )
}
