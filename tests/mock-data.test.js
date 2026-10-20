import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../src/config/env.js';
import { pool } from '../src/config/db.js';
import { loadMockData, MOCK_TABLES, readMockTable } from '../scripts/lib/mockData.js';
import { api, closeDatabase } from './helpers.js';

// Password of every account in database/mock-data (documented in miata-api/README.md).
const MOCK_PASSWORD = 'Miata-6C75DR9';

before(async () => {
  await loadMockData({ database: env.databases.mock, uploadDir: env.uploads.dir, reset: true });
});
after(closeDatabase);

describe('mock data', () => {
  it('loads every mock table completely, with no duplicates', async () => {
    for (const table of MOCK_TABLES) {
      const expected = (await readMockTable(table)).length;
      const { rows } = await pool.query(`SELECT count(*)::int AS n, count(DISTINCT to_jsonb(t)::text)::int AS d FROM ${table} t`);
      assert.equal(rows[0].n, expected, `${table} row count`);
      assert.equal(rows[0].d, rows[0].n, `${table} has duplicate rows`);
    }
  });

  it('keeps relationships intact and continues id sequences after the loaded rows', async () => {
    const { rows } = await pool.query(`INSERT INTO courses (code, title) VALUES ('SEQCHECK', 'Sequence check') RETURNING id`);
    const maxMockId = Math.max(...(await readMockTable('courses')).map((c) => c.id));
    assert.ok(rows[0].id > maxMockId, 'new ids continue after the mock ids');
  });

  it('copies every referenced upload file', async () => {
    for (const f of await readMockTable('files')) {
      const file = path.join(env.uploads.dir, f.storage_key);
      assert.ok(fs.existsSync(file), `${f.storage_key} exists`);
      assert.equal(fs.statSync(file).size, Number(f.size_bytes), `${f.storage_key} size`);
    }
  });

  it('serves the mock data through the API for every role', async () => {
    const expectations = {
      'admin@miata.local': ['admin', '/api/admin/dashboard', (d) => d.stats.totalStudents === 8],
      'ramesh.agent@miata.local': ['agent', '/api/agent/dashboard', (d) => d.counts.total === 4],
      'robert.wilson@miata.local': ['professor', '/api/professor/dashboard', (d) => d.stats.totalStudents > 0],
      'arun.kumar@miata.local': ['student', '/api/student/dashboard', (d) => d.stats.totalCourses === 1],
    };
    for (const [email, [role, path, check]] of Object.entries(expectations)) {
      const login = await api().post('/api/auth/login').send({ email, password: MOCK_PASSWORD, role });
      assert.equal(login.status, 200, `${email} can sign in`);
      const res = await api().get(path).set('Authorization', `Bearer ${login.body.data.accessToken}`);
      assert.equal(res.status, 200, path);
      assert.ok(check(res.body.data), `${path} returns the mock records`);
    }
  });

  it('includes fees, payment proofs, an expired student and an agent application', async () => {
    const login = await api().post('/api/auth/login').send({ email: 'arun.kumar@miata.local', password: MOCK_PASSWORD, role: 'student' });
    const fees = await api().get('/api/student/fees').set('Authorization', `Bearer ${login.body.data.accessToken}`);
    assert.deepEqual(fees.body.data.totals, { payable: 26000, paid: 10000, pending: 6000, balance: 16000 });
    assert.equal(fees.body.data.payments.length, 2);

    const expired = await api()
      .post('/api/auth/login')
      .send({ email: 'vikram.singh@miata.local', password: MOCK_PASSWORD, role: 'student' });
    assert.equal(expired.status, 403);
    assert.match(expired.body.error.message, /course access period has ended/);

    const { rows } = await pool.query(`SELECT source, applied_course_id FROM agent_referrals WHERE student_id = 11`);
    assert.deepEqual(rows[0], { source: 'agent', applied_course_id: 1 });
  });

  it('refuses to load mock data into the live database', async () => {
    await assert.rejects(loadMockData({ database: env.databases.live, uploadDir: env.uploads.dir }), /live database/);
  });
});
