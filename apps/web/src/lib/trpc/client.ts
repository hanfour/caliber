'use client'
import { createTRPCReact } from '@trpc/react-query'
import type { AppRouter } from '@caliber/api-types'

export const trpc = createTRPCReact<AppRouter>()
