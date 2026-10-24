import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { API_ROOT, env } from '../../src/config/env.js';
import { ensureDatabase, runMigrations } from '../../src/config/migrator.js';

export const MOCK_DATA_DIR = path.join(API_ROOT, 'database', 'mock-data');

// Insertion order respects foreign keys. Session tokens are never part of mock data.
export const MOCK_TABLES = [
  'users',
  'student_profiles',
  'professor_profiles',
  'agent_profiles',
  'courses',
  'agent_referrals',
  'modules',
  'course_lecturers',
  'lessons',
  'batches',
  'batch_courses',
  'batch_students',
  'batch_professors',
  'module_batches',
  'course_enrolments',
  'professor_course_assignments',
  'professor_module_assignments',
  'module_statuses',
  'files',
  'fee_payments',
  'videos',
  'video_batches',
  'video_progress',
  'assignments',
  'assignment_students',
  'assignment_submissions',
  'assignment_reviews',
  'submission_comments',
  'enquiries',
  'enquiry_notes',
  'notifications',
  'activity_logs',
  'app_settings',
  'meetings',
  'meeting_participants',
  'email_deliveries',
];

// Tables without an identity `id` column (no sequence to move past the loaded rows).
const NO_IDENTITY = new Set(['app_settings', 'meeting_participants']);

export async function readMockTable(table) {
  return JSON.parse(await fs.readFile(path.join(MOCK_DATA_DIR, 'tables', `${table}.json`), 'utf8'));
}

/**
 * Load database/mock-data into `database` (and its files into `uploadDir`). Refuses to touch the live
 * database. With `reset`, the target schema is dropped first; otherwise the target must be empty.
 */
export async function loadMockData({ database, uploadDir, reset = false, log = () => {} }) {
  if (database === env.databases.live) {
    throw new Error(`Refusing to load mock data into the live database "${database}".`);
  }
  await ensureDatabase(database);
  const client = new pg.Client({ ...env.db, database });
  await client.connect();
  try {
    if (reset) {
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      await fs.rm(uploadDir, { recursive: true, force: true });
    }
    await runMigrations({ database, log });

    const { rows } = await client.query('SELECT count(*)::int AS n FROM users');
    if (rows[0].n > 0) throw new Error(`"${database}" already has data. Run with --reset to reload the mock data.`);

    const counts = {};
    await client.query('BEGIN');
    for (const table of MOCK_TABLES) {
      const data = await readMockTable(table);
      counts[table] = data.length;
      if (!data.length) continue;
      if (table === 'app_settings') {
        await client.query(
          `INSERT INTO app_settings SELECT * FROM json_populate_recordset(NULL::app_settings, $1::json)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
          [JSON.stringify(data)],
        );
        continue;
      }
      // Ids are kept as exported so every relationship stays intact.
      await client.query(`INSERT INTO ${table} OVERRIDING SYSTEM VALUE SELECT * FROM json_populate_recordset(NULL::${table}, $1::json)`, [
        JSON.stringify(data),
      ]);
    }
    // Continue identity and code sequences after the loaded rows.
    for (const table of MOCK_TABLES) {
      if (NO_IDENTITY.has(table) || table.endsWith('_profiles')) continue;
      await client.query(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE(max(id), 1), max(id) IS NOT NULL) FROM ${table}`,
      );
    }
    await client.query(
      `SELECT setval('student_code_seq', COALESCE(max(substring(student_code FROM 4)::int), 1001), max(student_code) IS NOT NULL) FROM student_profiles`,
    );
    await client.query(
      `SELECT setval('professor_code_seq', COALESCE(max(substring(employee_code FROM 4)::int), 1001), max(employee_code) IS NOT NULL) FROM professor_profiles`,
    );
    await client.query('COMMIT');

    await fs.cp(path.join(MOCK_DATA_DIR, 'uploads'), uploadDir, { recursive: true });
    return counts;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}
