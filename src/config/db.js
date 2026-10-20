import pg from 'pg';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

// COUNT(*) and BIGINT ids come back as strings by default; all our values fit safely in a JS number.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number.parseFloat(v));
// Keep DATE columns as 'YYYY-MM-DD' strings so they are not shifted by the server timezone.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export const pool = new pg.Pool({ ...env.db, max: 10, idleTimeoutMillis: 30_000 });

pool.on('error', (err) => logger.error('Unexpected PostgreSQL pool error', { error: err.message }));

/** Run a parameterised query on the shared pool. */
export const query = (text, params) => pool.query(text, params);

/**
 * Run `fn(client)` inside a transaction. Everything succeeds or everything is rolled back.
 * Services accept an optional `db` argument so they can join a caller's transaction.
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function checkConnection() {
  const { rows } = await pool.query('SELECT current_database() AS db, version() AS version');
  return rows[0];
}
