'use client'

import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ShieldAlert } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { RequirePerm } from '@/components/RequirePerm'
import { AccountList } from '@/components/accounts/AccountList'
import { trpc } from '@/lib/trpc/client'

export default function AccountsTab() {
  const params = useParams()
  // The `[id]` route param can be either the org's UUID (admin nav) or the
  // slug (when an operator pastes a docs URL like
  // /dashboard/organizations/local/accounts). Resolve via the shared tRPC
  // query so AccountList's accounts.list query always sees the canonical
  // UUID — closes #202 (the slug was passed straight through to
  // accounts.list's z.string().uuid() schema and errored as «UUID 格式不正確»).
  const identifier = params?.id as string
  const t = useTranslations('accountsPage')
  const tOrg = useTranslations('org.overview')
  const { data: org, isLoading, error } = trpc.organizations.resolveIdentifier.useQuery(
    { identifier },
    { enabled: !!identifier },
  )

  // While the resolver runs, leave the page in a holding state. RequirePerm
  // needs a UUID for the action's orgId; rendering it with a slug would
  // itself produce a misleading "no permission" fallback because the
  // underlying check skips slug-keyed perms.
  if (isLoading) {
    return (
      <div className="space-y-4">
        <Card className="shadow-card p-6 text-sm text-muted-foreground">
          Loading…
        </Card>
      </div>
    )
  }
  if (error || !org) {
    return (
      <div className="space-y-4">
        <Card className="shadow-card flex flex-col items-center p-10 text-center">
          <ShieldAlert className="h-6 w-6 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-semibold">Organization not found</h3>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            {error?.message ?? `No organization matched "${identifier}".`}
          </p>
        </Card>
      </div>
    )
  }

  const orgId = org.id

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold tracking-tight">{tOrg('upstreamAccounts')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('subtitle')}
        </p>
      </div>

      <RequirePerm
        action={{ type: 'account.read', orgId }}
        fallback={
          <Card className="shadow-card flex flex-col items-center p-10 text-center">
            <ShieldAlert className="h-6 w-6 text-muted-foreground" />
            <h3 className="mt-3 text-sm font-semibold">{t('cantViewTitle')}</h3>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              {t.rich('cantViewHint', {
                code: (chunks) => <code className="font-mono">{chunks}</code>
              })}
            </p>
          </Card>
        }
      >
        <AccountList orgId={orgId} />
      </RequirePerm>
    </div>
  )
}
