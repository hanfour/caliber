import type { Database } from '@caliber/db'
import { auditLogs } from '@caliber/db'

// `writeAudit` needs to run inside a transaction as well as against the root
// `Database`. The transaction callback's parameter type is a narrower
// `PgTransaction`, so we derive a union here to accept either safely.
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]
export type AuditDb = Database | Tx

export interface AuditEntry {
  actorUserId: string
  action: string
  targetType?: string
  targetId?: string
  orgId?: string | null
  metadata?: Record<string, unknown>
}

export async function writeAudit(db: AuditDb, entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    actorUserId: entry.actorUserId,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    orgId: entry.orgId ?? null,
    metadata: entry.metadata ?? {}
  })
}
