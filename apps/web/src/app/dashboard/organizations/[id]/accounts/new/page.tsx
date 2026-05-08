'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, ShieldAlert } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { RequirePerm } from '@/components/RequirePerm'
import { AccountCreateForm } from '@/components/accounts/AccountCreateForm'
import { trpc } from '@/lib/trpc/client'

export default function NewAccountPage() {
  const params = useParams()
  // The `[id]` route param can be either the org's UUID (admin nav)
  // or the slug (when an operator pastes a docs URL like
  // /dashboard/organizations/local/accounts/new). Resolve via the
  // shared tRPC query so downstream mutations always see the canonical
  // UUID — closes #70 (BAD_REQUEST when slug was passed straight
  // through to accounts.create's z.string().uuid() schema).
  const identifier = params?.id as string
  const { data: org, isLoading, error } = trpc.organizations.resolveIdentifier.useQuery(
    { identifier },
    { enabled: !!identifier },
  )

  // While the resolver runs, leave the page in a holding state.
  // RequirePerm needs a UUID for the action's orgId; rendering it
  // with a slug would itself produce a misleading "no permission"
  // fallback because the underlying check skips slug-keyed perms.
  if (isLoading) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <Card className="shadow-card p-6 text-sm text-muted-foreground">
          Loading…
        </Card>
      </div>
    )
  }
  if (error || !org) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
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
    <div className="mx-auto max-w-2xl space-y-6">
      <Link
        href={`/dashboard/organizations/${orgId}/accounts`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to accounts
      </Link>

      <RequirePerm
        action={{ type: 'account.create', orgId, teamId: null }}
        fallback={
          <Card className="shadow-card flex flex-col items-center p-10 text-center">
            <ShieldAlert className="h-6 w-6 text-muted-foreground" />
            <h3 className="mt-3 text-sm font-semibold">You can’t create accounts here</h3>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              Ask a workspace admin for the <code className="font-mono">account.create</code>{' '}
              permission.
            </p>
          </Card>
        }
      >
        <Card className="shadow-card">
          <CardHeader>
            <CardTitle>New upstream account</CardTitle>
            <CardDescription>
              Add an Anthropic credential that the gateway can use to route requests.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AccountCreateForm orgId={orgId} />
          </CardContent>
        </Card>
      </RequirePerm>
    </div>
  )
}
