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

/**
 * Attach a no-op 'error' listener so async pool-level errors during teardown
 * don't fail the run.
 *
 * node-postgres re-emits an idle client's connection error on the Pool itself.
 * When a testcontainer Postgres is stopped in afterAll — or reaped at the end
 * of the run — any still-idle pooled client receives a FATAL 57P01
 * ("terminating connection due to administrator command"). With no listener,
 * Node throws that 'error' event as an uncaught exception, which Vitest counts
 * as a failed run even when every test passed. A genuine mid-test connection
 * fault still rejects its own awaited query, so this only swallows expected
 * teardown noise. Mirrors the redis.on('error') guard in src/server.ts.
 */
export function ignorePoolTeardownErrors(pool: pg.Pool): pg.Pool {
  pool.on('error', () => {})
  return pool
}

export async function setupTestDb() {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start()
  const pool = ignorePoolTeardownErrors(
    new pg.Pool({ connectionString: container.getConnectionUri() })
  )
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
