// Verifies that two databases hold the same data: row counts and a checksum of every table's rows.
//   npm run db:compare -- <databaseA> <databaseB>
// Used to prove a data migration lost, duplicated or changed nothing. Session tokens are skipped.
import pg from 'pg';
import { env } from '../src/config/env.js';

const [dbA, dbB] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!dbA || !dbB) {
  console.error('Usage: npm run db:compare -- <databaseA> <databaseB>');
  process.exit(1);
}
const SKIP = new Set(['schema_migrations', 'refresh_tokens', 'password_reset_tokens']);

async function fingerprint(database) {
  const client = new pg.Client({ ...env.db, database });
  await client.connect();
  try {
    const { rows: tables } = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`,
    );
    const result = {};
    for (const { table_name: t } of tables) {
      if (SKIP.has(t)) continue;
      // Rows are compared as JSON in key order, independent of column order and constraint names.
      const { rows } = await client.query(
        `SELECT count(*)::int AS n,
                md5(COALESCE(string_agg(to_jsonb(x)::text, '|' ORDER BY to_jsonb(x)::text), '')) AS sum,
                (count(*) - count(DISTINCT to_jsonb(x)::text))::int AS duplicates
           FROM ${t} x`,
      );
      result[t] = rows[0];
    }
    return result;
  } finally {
    await client.end();
  }
}

const [a, b] = await Promise.all([fingerprint(dbA), fingerprint(dbB)]);
let problems = 0;
console.log(`${'table'.padEnd(30)} ${dbA.padStart(12)} ${dbB.padStart(12)}  result`);
for (const t of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
  const [x, y] = [a[t], b[t]];
  let status = 'identical';
  if (!x || !y) status = `missing in ${x ? dbB : dbA}`;
  else if (x.n !== y.n) status = 'ROW COUNT DIFFERS';
  else if (x.sum !== y.sum) status = 'DATA DIFFERS';
  else if (x.duplicates || y.duplicates) status = 'DUPLICATE ROWS';
  if (status !== 'identical') problems += 1;
  console.log(`${t.padEnd(30)} ${String(x?.n ?? '-').padStart(12)} ${String(y?.n ?? '-').padStart(12)}  ${status}`);
}
console.log(problems ? `\n${problems} table(s) differ.` : '\nAll tables are identical (no missing, duplicate or changed rows).');
process.exitCode = problems ? 1 : 0;
