import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@caliber/db/schema";
import { makeAdapter } from "../../src/drizzle-adapter";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {});  // swallow 57P01 admin-shutdown on container teardown
  db = drizzle(pool, { schema }) as unknown as ReturnType<typeof drizzle>;
});

afterAll(async () => {
  await pool.end();
  await container.stop();
});

describe("makeAdapter", () => {
  it("returns a next-auth adapter with the expected method surface", () => {
    const adapter = makeAdapter(db as never);
    expect(adapter).toBeTruthy();
    expect(typeof adapter).toBe("object");
    expect(typeof adapter.createUser).toBe("function");
    expect(typeof adapter.getUser).toBe("function");
    expect(typeof adapter.getUserByEmail).toBe("function");
    expect(typeof adapter.linkAccount).toBe("function");
    expect(typeof adapter.createSession).toBe("function");
  });
});
