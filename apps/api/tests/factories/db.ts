import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import path from 'node:path'
import { createRequire } from 'node:module'
import * as schema from '@caliber/db/schema'

const require = createRequire(import.meta.url)
export const migrationsFolder = path.resolve(
  path.dirname(require.resolve('@caliber/db/package.json')),
  'drizzle'
)

export async function setupTestDb() {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start()
  const pool = new pg.Pool({ connectionString: container.getConnectionUri() })
  const db = drizzle(pool, { schema })
  await migrate(db as never, { migrationsFolder })
  return {
    db,
    pool,
    container,
    url: container.getConnectionUri(),
    async stop() {
      await pool.end()
      await container.stop()
    }
  }
}

export type TestDb = Awaited<ReturnType<typeof setupTestDb>>
export type { StartedPostgreSqlContainer }
