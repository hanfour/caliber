import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { organizations, users } from '../src/schema/index.js'
import { organizationMembers } from '../src/schema/membership.js'
import { roleAssignments } from '../src/schema/roles.js'

let container: StartedPostgreSqlContainer | undefined
let pool: pg.Pool | undefined
let db: ReturnType<typeof drizzle>

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  pool = new pg.Pool({ connectionString: container.getConnectionUri() })
  pool.on("error", () => {});  // swallow 57P01 admin-shutdown on container teardown
  db = drizzle(pool)
  const here = path.dirname(fileURLToPath(import.meta.url))
  await migrate(db, { migrationsFolder: path.resolve(here, '..', 'drizzle') })
})

afterAll(async () => {
  if (pool) await pool.end()
  if (container) await container.stop()
})

describe('schema round-trip', () => {
  it('creates an org and super_admin with role_assignment', async () => {
    const [org] = await db
      .insert(organizations)
      .values({ slug: 'test-org', name: 'Test' })
      .returning()

    const [user] = await db
      .insert(users)
      .values({ email: 'root@test.com', name: 'Root' })
      .returning()

    await db
      .insert(organizationMembers)
      .values({ orgId: org!.id, userId: user!.id })

    const [ra] = await db
      .insert(roleAssignments)
      .values({ userId: user!.id, role: 'super_admin', scopeType: 'global' })
      .returning()

    expect(ra?.role).toBe('super_admin')
    expect(ra?.scopeType).toBe('global')
  })

  it('rejects duplicate org slug', async () => {
    await db.insert(organizations).values({ slug: 'dup', name: 'A' })
    await expect(
      db.insert(organizations).values({ slug: 'dup', name: 'B' })
    ).rejects.toThrow()
  })

  it('rejects duplicate team slug within same org', async () => {
    const [org] = await db
      .insert(organizations)
      .values({ slug: 'unique-slug-org', name: 'X' })
      .returning()

    const { teams } = await import('../src/schema/index.js')
    await db.insert(teams).values({ orgId: org!.id, name: 'A', slug: 'engineering' })
    await expect(
      db.insert(teams).values({ orgId: org!.id, name: 'B', slug: 'engineering' })
    ).rejects.toThrow()
  })
})
