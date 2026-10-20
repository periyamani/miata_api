import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { API_ROOT, env } from './env.js';

const MIGRATIONS_DIR = path.join(API_ROOT, 'database', 'migrations');
// Arbitrary constant so two migration runs can never interleave.
const LOCK_ID = 74_726_371;

/**
 * Apply every pending migrations/*.sql file in name order, each in its own transaction,
 * recording applied files in schema_migrations.
 */
export async function runMigrations({ database = env.db.database, log = console.log } = {}) {
  const client = new pg.Client({ ...env.db, database });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    const pending = files.filter((f) => !applied.has(f));
    for (const file of pending) {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`  applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`, { cause: err });
      }
    }
    return pending;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    await client.end();
  }
}

/** Names of migration files not yet applied (used by the server to refuse starting on an old schema). */
export async function pendingMigrations({ database = env.db.database } = {}) {
  const client = new pg.Client({ ...env.db, database });
  await client.connect();
  try {
    const { rows: exists } = await client.query(`SELECT to_regclass('public.schema_migrations') AS t`);
    const applied = exists[0].t ? new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name)) : new Set();
    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    return files.filter((f) => !applied.has(f));
  } finally {
    await client.end();
  }
}

/** Create a database if it does not exist (connects to the `postgres` maintenance database). */
export async function ensureDatabase(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Refusing to create database with unsafe name "${name}"`);
  const client = new pg.Client({ ...env.db, database: 'postgres' });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (rowCount) return false;
    // Identifiers cannot be parameterised; the name is validated above.
    await client.query(`CREATE DATABASE "${name}" ENCODING 'UTF8' TEMPLATE template0`);
    return true;
  } finally {
    await client.end();
  }
}
