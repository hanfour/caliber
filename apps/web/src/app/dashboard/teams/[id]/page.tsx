'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Pencil, Trash2, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { trpc } from '@/lib/trpc/client'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import { useConfirm } from '@/components/ui/confirm-dialog'

export default function TeamDetailPage() {
  const params = useParams()
  const router = useRouter()
  const confirm = useConfirm()
  const teamId = params?.id as string
  const [searchEmail, setSearchEmail] = useState('')
  const [editOpen, setEditOpen] = useState(false)
  const [draftName, setDraftName] = useState('')
  const utils = trpc.useUtils()
  const { data: team } = trpc.teams.get.useQuery({ id: teamId })
  const { data: members, isLoading } = trpc.users.list.useQuery({ teamId })
  const { data: session } = trpc.me.session.useQuery()

  useEffect(() => {
    if (team?.name) setDraftName(team.name)
  }, [team?.name])

  const canManage =
    session?.assignments.some(
      (a: { role: string; scopeType: string; scopeId: string | null }) =>
        (a.role === 'team_manager' && a.scopeId === teamId) ||
        a.role === 'org_admin' ||
        a.role === 'super_admin' ||
        a.role === 'dept_manager'
    ) ?? false

  const addMember = trpc.teams.addMember.useMutation({
    onSuccess: () => {
      toast.success('Member added')
      setSearchEmail('')
      utils.users.list.invalidate({ teamId })
    },
    onError: (e) => toast.error(e.message)
  })

  const removeMember = trpc.teams.removeMember.useMutation({
    onSuccess: () => {
      toast.success('Member removed')
      utils.users.list.invalidate({ teamId })
    },
    onError: (e) => toast.error(e.message)
  })

  const updateTeam = trpc.teams.update.useMutation({
    onSuccess: async (updated) => {
      toast.success(`Team "${updated.name}" updated`)
      setEditOpen(false)
      await utils.teams.get.invalidate({ id: teamId })
      await utils.teams.list.invalidate({ orgId: updated.orgId })
    },
    onError: (e) => toast.error(e.message)
  })

  const deleteTeam = trpc.teams.delete.useMutation({
    onSuccess: async () => {
      toast.success('Team deleted')
      if (team?.orgId) {
        await utils.teams.list.invalidate({ orgId: team.orgId })
        router.push(`/dashboard/organizations/${team.orgId}/teams`)
      } else {
        router.push('/dashboard')
      }
    },
    onError: (e) => toast.error(e.message)
  })

  async function handleAdd() {
    if (!searchEmail.trim()) return
    // Look up user by email via list-with-search. tRPC users.list supports search.
    const results = await utils.users.list.fetch({ search: searchEmail.trim() })
    const user = results.find((u) => u.email === searchEmail.trim())
    if (!user) {
      toast.error('User not found')
      return
    }
    await addMember.mutateAsync({ teamId, userId: user.id })
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/dashboard/organizations/${team?.orgId ?? ''}/teams`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to teams
      </Link>

      <div>
        <h2 className="text-2xl font-semibold tracking-tight">{team?.name ?? '…'}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">/{team?.slug ?? '…'}</p>
      </div>

      {canManage && (
        <Card className="shadow-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium">Team settings</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Rename or remove this team.
              </p>
            </div>
            <div className="flex gap-2">
              <Dialog open={editOpen} onOpenChange={setEditOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline" className="gap-1.5">
                    <Pencil className="h-4 w-4" />
                    Edit team
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Edit team</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-1.5">
                    <Label htmlFor="team-name">Name</Label>
                    <Input
                      id="team-name"
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                    />
                  </div>
                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => setEditOpen(false)}>
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      onClick={() => updateTeam.mutate({ id: teamId, name: draftName.trim() })}
                      disabled={!draftName.trim() || updateTeam.isPending}
                    >
                      Save
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              <Button
                variant="destructive"
                className="gap-1.5"
                disabled={deleteTeam.isPending}
                onClick={async () => {
                  if (!team?.name) return
                  const ok = await confirm({
                    description: `Delete team "${team.name}"?`,
                    destructive: true,
                  })
                  if (!ok) return
                  deleteTeam.mutate({ id: teamId })
                }}
              >
                <Trash2 className="h-4 w-4" />
                Delete team
              </Button>
            </div>
          </div>
        </Card>
      )}

      {canManage && (
        <Card className="shadow-card p-4">
          <h3 className="mb-2 text-sm font-medium">Add member</h3>
          <div className="flex gap-2">
            <Input
              value={searchEmail}
              onChange={(e) => setSearchEmail(e.target.value)}
              placeholder="email@example.com"
              className="flex-1"
            />
            <Button onClick={handleAdd} disabled={addMember.isPending} className="gap-1.5">
              <UserPlus className="h-4 w-4" />
              Add
            </Button>
          </div>
        </Card>
      )}

      <Card className="shadow-card overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-sm font-medium">Members {members ? `(${members.length})` : ''}</h3>
        </div>
        {isLoading ? (
          <div className="p-6 text-sm text-muted-foreground">Loading…</div>
        ) : !members || members.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">No members yet.</div>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {members.map((m) => (
                <tr key={m.id} className="border-b border-border last:border-0 hover:bg-accent/20">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <Avatar className="h-8 w-8">
                        <AvatarFallback className="bg-primary/10 text-primary text-xs">
                          {m.email.charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <div className="font-medium">{m.name ?? m.email}</div>
                        <div className="text-xs text-muted-foreground">{m.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          removeMember.mutate({ teamId, userId: m.id })
                        }
                        className="text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}
