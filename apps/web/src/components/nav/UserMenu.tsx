'use client'

import Link from 'next/link'
import { LogOut, User } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { trpc } from '@/lib/trpc/client'

export function UserMenu() {
  const { data: session } = trpc.me.session.useQuery()
  const email = session?.user?.email ?? '...'
  const name = session?.user?.name ?? undefined
  const image = session?.user?.image ?? undefined
  const displayName = name || email
  const initial = displayName.charAt(0).toUpperCase()

  async function handleSignOut() {
    // POST to next-auth signout endpoint to clear session cookie
    await fetch('/api/auth/signout', { method: 'POST', credentials: 'same-origin' })
    window.location.href = '/sign-in'
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex items-center gap-2 rounded-md p-1 hover:bg-accent/50"
          aria-label="User menu"
        >
          <Avatar className="h-8 w-8">
            {image && <AvatarImage src={image} alt={displayName} />}
            <AvatarFallback className="bg-primary text-xs text-primary-foreground">
              {initial}
            </AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          {name && <div className="text-sm font-medium">{name}</div>}
          <div className="text-xs text-muted-foreground">{email}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/dashboard/profile" className="cursor-pointer">
            <User className="mr-2 h-4 w-4" />
            Profile
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={handleSignOut}
          className="cursor-pointer text-destructive focus:text-destructive"
        >
          <LogOut className="mr-2 h-4 w-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
