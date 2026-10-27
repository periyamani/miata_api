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
      'admin@miata.local': ['admin', '/api/admin/dashboard', (d) => d.stats.totalStudents === 5],
      'ramesh.agent@miata.local': ['agent', '/api/agent/dashboard', (d) => d.counts.total === 2],
      'niveditha@miata.local': ['professor', '/api/professor/modules', (d) => d.length === 4],
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

  it('holds only the required accounts: one admin, the five lecturers as professors, five students and two agents', async () => {
    const { rows } = await pool.query(`SELECT role, array_agg(full_name ORDER BY id) AS names FROM users WHERE is_active GROUP BY role ORDER BY role`);
    assert.deepEqual(rows, [
      { role: 'admin', names: ['MIATA Administrator'] },
      { role: 'agent', names: ['Ramesh Kumar', 'Priya Nair'] },
      { role: 'professor', names: ['Dr. Niveditha', 'Jai', 'Dr. Saranya', 'Dr. Suzmitha', 'Dr. Bagyavasan'] },
      { role: 'student', names: ['Arun Kumar', 'Priya Sharma', 'Sneha Reddy', 'Meera Iyer', 'Divya Pillai'] },
    ]);
    const { rows: inactive } = await pool.query('SELECT count(*)::int AS n FROM users WHERE NOT is_active');
    assert.equal(inactive[0].n, 0);
  });

  it('includes fees, payment proofs, batches and agent referrals for the students', async () => {
    const login = await api().post('/api/auth/login').send({ email: 'arun.kumar@miata.local', password: MOCK_PASSWORD, role: 'student' });
    const fees = await api().get('/api/student/fees').set('Authorization', `Bearer ${login.body.data.accessToken}`);
    assert.deepEqual(fees.body.data.totals, { payable: 26000, paid: 10000, pending: 6000, balance: 16000 });
    assert.equal(fees.body.data.payments.length, 2);

    const { rows } = await pool.query(
      `SELECT u.full_name, b.name AS batch, a.full_name AS agent FROM users u
       JOIN batch_students bs ON bs.student_id = u.id JOIN batches b ON b.id = bs.batch_id
       LEFT JOIN agent_referrals r ON r.student_id = u.id LEFT JOIN users a ON a.id = r.agent_id
       WHERE u.role = 'student' ORDER BY u.id`,
    );
    assert.deepEqual(
      rows.map((r) => [r.full_name, r.batch, r.agent]),
      [
        ['Arun Kumar', 'PGDU Batch 2026-A', 'Ramesh Kumar'],
        ['Priya Sharma', 'PGDU Batch 2026-A', 'Ramesh Kumar'],
        ['Sneha Reddy', 'PGDU Batch 2026-A', 'Priya Nair'],
        ['Meera Iyer', 'Clinical Training 2026', null],
        ['Divya Pillai', 'PGDU Batch 2026-B', null],
      ],
    );
  });

  it('includes the 2026–2027 MIATA Postgraduate Sonography course with its weekly timetable', async () => {
    const login = await api().post('/api/auth/login').send({ email: 'admin@miata.local', password: MOCK_PASSWORD, role: 'admin' });
    const res = await api().get('/api/admin/courses/6').set('Authorization', `Bearer ${login.body.data.accessToken}`);
    const course = res.body.data;
    assert.equal(course.title, 'MIATA Postgraduate Sonography');
    assert.deepEqual([course.academicYear, course.startDate, course.endDate], ['2026–2027', '2026-10-19', '2027-04-18']);
    assert.equal(course.modules.length, 15);
    const lessons = course.modules.flatMap((m) => m.lessons);
    assert.equal(lessons.filter((l) => !l.weekNumber).length, 212, 'curriculum topics');
    assert.equal(lessons.filter((l) => l.weekNumber).length, 96, 'weekly sessions');
    assert.deepEqual(
      course.lecturers.map((l) => [l.lecturerName, l.sessionCount, l.professorName]),
      [
        ['Dr. Niveditha', 26, 'Dr. Niveditha'],
        ['Jai', 24, 'Jai'],
        ['Dr. Saranya', 8, 'Dr. Saranya'],
        ['Dr. Suzmitha', 12, 'Dr. Suzmitha'],
        ['Dr. Bagyavasan', 26, 'Dr. Bagyavasan'],
      ],
      'each lecturer linked to their professor account',
    );
    // Module professors are the lecturers of each module's sessions; nobody teaches the excluded cardiac module.
    assert.deepEqual(
      course.modules.map((m) => m.professors.map((p) => p.fullName).join(', ')),
      [
        'Dr. Niveditha',
        'Dr. Bagyavasan, Dr. Niveditha',
        'Dr. Niveditha',
        'Dr. Bagyavasan, Dr. Saranya',
        'Dr. Niveditha',
        'Dr. Bagyavasan, Dr. Saranya',
        'Jai',
        '',
        'Dr. Bagyavasan',
        'Dr. Bagyavasan',
        'Dr. Bagyavasan',
        'Dr. Bagyavasan',
        'Dr. Bagyavasan',
        'Dr. Bagyavasan',
        'Dr. Suzmitha',
      ],
    );

    const lecturer = await api().post('/api/auth/login').send({ email: 'niveditha@miata.local', password: MOCK_PASSWORD, role: 'professor' });
    const timetable = await api().get('/api/professor/timetable').set('Authorization', `Bearer ${lecturer.body.data.accessToken}`);
    assert.equal(timetable.body.data.length, 1);
    assert.equal(timetable.body.data[0].myLecturerIds.length, 1);
  });

  it('includes module statuses set by the professors who teach them', async () => {
    const login = await api().post('/api/auth/login').send({ email: 'niveditha@miata.local', password: MOCK_PASSWORD, role: 'professor' });
    const res = await api().get('/api/professor/modules').set('Authorization', `Bearer ${login.body.data.accessToken}`);
    assert.deepEqual(
      res.body.data.map((m) => m.teachingStatus),
      ['in_progress', 'not_started', 'not_started', 'not_started'],
    );
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM module_statuses WHERE status = 'in_progress'`);
    assert.equal(rows[0].n, 7);
  });

  it('refuses to load mock data into the live database', async () => {
    await assert.rejects(loadMockData({ database: env.databases.live, uploadDir: env.uploads.dir }), /live database/);
  });
});
