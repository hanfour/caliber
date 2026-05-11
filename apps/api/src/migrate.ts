import path from "node:path";
import { createRequire } from "node:module";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const require = createRequire(import.meta.url);

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool);

  const migrationsFolder =
    process.env.DRIZZLE_MIGRATIONS_FOLDER ??
    path.resolve(path.dirname(require.resolve("@caliber/db/package.json")), "drizzle");

  // eslint-disable-next-line no-console
  console.log(`Applying migrations from ${migrationsFolder}`);
  await migrate(db, { migrationsFolder });
  // eslint-disable-next-line no-console
  console.log("Migrations complete.");

  await pool.end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
