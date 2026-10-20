import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/config/db.js';
import { api, closeDatabase, createUser, resetDatabase, userWithToken } from './helpers.js';

let admin, agentA, agentB, professor, student;

async function registerVia(agentId, email) {
  const { rows } = await pool.query('SELECT referral_code FROM agent_profiles WHERE user_id = $1', [agentId]);
  const res = await api()
    .post('/api/auth/register')
    .send({ fullName: email.split('@')[0], email, password: 'Student123', referralCode: rows[0].referral_code, acceptTerms: true });
  assert.equal(res.status, 201);
  return res.body.data.user;
}

before(async () => {
  await resetDatabase();
  admin = await userWithToken('admin');
  agentA = await userWithToken('agent');
  agentB = await userWithToken('agent');
  professor = await userWithToken('professor');
  student = await userWithToken('student');
});
after(closeDatabase);

describe('role namespaces', () => {
  const matrix = [
    ['/api/admin/dashboard', 'admin'],
    ['/api/agent/dashboard', 'agent'],
    ['/api/professor/dashboard', 'professor'],
    ['/api/student/dashboard', 'student'],
  ];

  it('rejects anonymous requests with 401', async () => {
    for (const [path] of matrix) assert.equal((await api().get(path)).status, 401, path);
  });

  it('allows only the owning role (403 for every other role)', async () => {
    const tokens = { admin, agent: agentA, professor, student };
    for (const [path, owner] of matrix) {
      for (const [role, who] of Object.entries(tokens)) {
        const res = await api().get(path).set(who.auth);
        assert.equal(res.status, role === owner ? 200 : 403, `${role} → ${path}`);
      }
    }
  });

  it('rejects tampered tokens', async () => {
    const forged = `${admin.token.slice(0, -4)}abcd`;
    const res = await api().get('/api/admin/dashboard').set('Authorization', `Bearer ${forged}`);
    assert.equal(res.status, 401);
  });

  it('ends sessions of a deactivated account immediately', async () => {
    const victim = await userWithToken('professor');
    const res = await api().patch(`/api/admin/professors/${victim.user.id}/status`).set(admin.auth).send({ isActive: false });
    assert.equal(res.status, 200);
    const after = await api().get('/api/professor/dashboard').set(victim.auth);
    assert.equal(after.status, 401);
  });
});

describe('agent referral isolation', () => {
  let studentOfA, studentOfB;

  before(async () => {
    studentOfA = await registerVia(agentA.user.id, 'refA1@test.local');
    await registerVia(agentA.user.id, 'refA2@test.local');
    studentOfB = await registerVia(agentB.user.id, 'refB1@test.local');
  });

  it('counts referrals from database records', async () => {
    const res = await api().get('/api/agent/dashboard').set(agentA.auth);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.counts.total, 2);
    assert.equal(res.body.data.counts.pending, 2, 'registered but not enrolled = pending');
  });

  it('lists only the agent’s own students and hides contact details', async () => {
    const res = await api().get('/api/agent/students').set(agentA.auth);
    assert.equal(res.body.meta.total, 2);
    assert.ok(res.body.data.every((r) => r.agentId === agentA.user.id));
    assert.ok(res.body.data.every((r) => r.email === undefined && r.phone === undefined));
  });

  it('ignores an agentId supplied by the client', async () => {
    const res = await api().get(`/api/agent/students?agentId=${agentB.user.id}`).set(agentA.auth);
    assert.ok(res.body.data.every((r) => r.agentId === agentA.user.id));
  });

  it('returns 404 for another agent’s student', async () => {
    assert.equal((await api().get(`/api/agent/students/${studentOfB.id}`).set(agentA.auth)).status, 404);
    assert.equal((await api().get(`/api/agent/students/${studentOfA.id}`).set(agentA.auth)).status, 200);
  });

  it('prevents duplicate attribution at the database level', async () => {
    await assert.rejects(
      pool.query(`INSERT INTO agent_referrals (agent_id, student_id, referral_code, source) VALUES ($1, $2, 'X', 'admin')`, [
        agentB.user.id,
        studentOfA.id,
      ]),
      /duplicate key/,
    );
  });

  it('lets only admins reassign ownership, and logs it', async () => {
    const denied = await api().put(`/api/admin/students/${studentOfA.id}/referral`).set(agentB.auth).send({ agentId: agentB.user.id });
    assert.equal(denied.status, 403);

    const res = await api().put(`/api/admin/students/${studentOfA.id}/referral`).set(admin.auth).send({ agentId: agentB.user.id });
    assert.equal(res.status, 200);
    assert.equal((await api().get('/api/agent/dashboard').set(agentA.auth)).body.data.counts.total, 1);
    assert.equal((await api().get('/api/agent/dashboard').set(agentB.auth)).body.data.counts.total, 2);

    const { rows } = await pool.query(`SELECT metadata FROM activity_logs WHERE action = 'referral.reassigned' AND entity_id = $1`, [
      studentOfA.id,
    ]);
    assert.equal(rows[0].metadata.previousAgentId, agentA.user.id);
  });

  it('derives Active / Completed status from enrolments', async () => {
    const course = await api().post('/api/admin/courses').set(admin.auth).send({ code: 'REF1', title: 'Referral course' });
    await api()
      .post(`/api/admin/courses/${course.body.data.id}/enrolments`)
      .set(admin.auth)
      .send({ studentIds: [studentOfB.id] });
    const res = await api().get('/api/agent/students?status=active').set(agentB.auth);
    assert.deepEqual(
      res.body.data.map((r) => r.studentId),
      [studentOfB.id],
    );
  });
});

describe('admin account management', () => {
  it('creates accounts that must change their temporary password at first login', async () => {
    const res = await api()
      .post('/api/admin/professors')
      .set(admin.auth)
      .send({ fullName: 'Dr Temp', email: 'temp.prof@test.local', temporaryPassword: 'Temporary123' });
    assert.equal(res.status, 201);
    const loginRes = await api().post('/api/auth/login').send({ email: 'temp.prof@test.local', password: 'Temporary123' });
    assert.equal(loginRes.body.data.passwordResetRequired, true);
    assert.equal(loginRes.body.data.reason, 'account_created');
  });

  it('does not allow creating admins through the API', async () => {
    const other = await createUser('student');
    const res = await api()
      .put(`/api/admin/students/${other.id}`)
      .set(admin.auth)
      .send({ fullName: 'X', email: other.email, role: 'admin' });
    assert.equal(res.status, 200);
    const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [other.id]);
    assert.equal(rows[0].role, 'student', 'unknown fields such as role are stripped');
  });
});
