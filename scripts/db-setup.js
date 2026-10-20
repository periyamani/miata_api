// Creates the database if needed and applies pending migrations (safe to run any time).
//   npm run db:setup            the live database (LIVE_DB_NAME)
//   npm run db:setup -- --mock  the mock database schema only (use npm run db:mock to also load mock data)
import { env } from '../src/config/env.js';
import { ensureDatabase, runMigrations } from '../src/config/migrator.js';

try {
  const { database } = env.db;
  const created = await ensureDatabase(database);
  console.log(created ? `Created database "${database}".` : `Database "${database}" exists.`);
  const applied = await runMigrations({ database });
  console.log(applied.length ? `${applied.length} migration(s) applied.` : 'Schema is up to date.');
} catch (err) {
  console.error(`Database setup failed: ${err.message}`);
  console.error('Check DB_HOST, DB_PORT, DB_USER and DB_PASSWORD in miata-api/.env and that PostgreSQL is running.');
  process.exitCode = 1;
}
