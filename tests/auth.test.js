import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/config/db.js';
import { api, closeDatabase, createUser, login, PASSWORD, resetDatabase } from './helpers.js';

const XHR = { 'X-Requested-With': 'XMLHttpRequest' };
const refreshCookie = (res) => res.headers['set-cookie']?.find((c) => c.startsWith('miata_rt='));

before(resetDatabase);
after(closeDatabase);

describe('login', () => {
  it('accepts the role chosen on the login page and refuses the wrong one', async () => {
    const professor = await createUser('professor');
    const ok = await api().post('/api/auth/login').send({ email: professor.email, password: PASSWORD, role: 'professor' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.user.role, 'professor');

    const wrong = await api().post('/api/auth/login').send({ email: professor.email, password: PASSWORD, role: 'student' });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.error.code, 'ROLE_MISMATCH');
    assert.equal(wrong.body.error.details.role, 'professor');
    assert.equal(refreshCookie(wrong), undefined, 'no session for the wrong role');
  });

  it('does not reveal the role when the password is wrong', async () => {
    const agent = await createUser('agent');
    const res = await api().post('/api/auth/login').send({ email: agent.email, password: 'Wrong12345', role: 'admin' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
  });

  it('rejects an unknown role value', async () => {
    const res = await api().post('/api/auth/login').send({ email: 'x@test.local', password: PASSWORD, role: 'superuser' });
    assert.equal(res.status, 422);
  });

  it('returns an access token, the user and an httpOnly refresh cookie', async () => {
    const admin = await createUser('admin');
    const res = await api().post('/api/auth/login').send({ email: admin.email.toUpperCase(), password: PASSWORD });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.accessToken);
    assert.equal(res.body.data.user.role, 'admin');
    assert.equal(res.body.data.user.passwordHash, undefined, 'password hash must never be returned');
    const cookie = refreshCookie(res);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Path=\/api\/auth/);

    const me = await api().get('/api/auth/me').set('Authorization', `Bearer ${res.body.data.accessToken}`);
    assert.equal(me.status, 200);
    assert.equal(me.body.data.email, admin.email);
  });

  it('rejects wrong passwords and unknown emails with the same error', async () => {
    const user = await createUser('student');
    const wrong = await api().post('/api/auth/login').send({ email: user.email, password: 'Wrong12345' });
    const unknown = await api().post('/api/auth/login').send({ email: 'nobody@test.local', password: 'Wrong12345' });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(wrong.body, unknown.body);
  });

  it('blocks deactivated accounts', async () => {
    const user = await createUser('agent');
    await pool.query('UPDATE users SET is_active = FALSE WHERE id = $1', [user.id]);
    const res = await api().post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'ACCOUNT_DISABLED');
  });

  it('validates the payload', async () => {
    const res = await api().post('/api/auth/login').send({ email: 'not-an-email' });
    assert.equal(res.status, 422);
    assert.ok(res.body.error.details.email);
  });
});

describe('refresh tokens', () => {
  it('rotates the refresh token and detects reuse of an old one', async () => {
    const user = await createUser('student');
    const first = await api().post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    const original = refreshCookie(first).split(';')[0];

    const rotated = await api().post('/api/auth/refresh').set(XHR).set('Cookie', original);
    assert.equal(rotated.status, 200);
    const next = refreshCookie(rotated).split(';')[0];
    assert.notEqual(next, original);

    // Push the first rotation outside the parallel-request grace window, then replay the old token.
    await pool.query(`UPDATE refresh_tokens SET revoked_at = now() - interval '5 minutes' WHERE revoked_at IS NOT NULL`);
    const replay = await api().post('/api/auth/refresh').set(XHR).set('Cookie', original);
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, 'SESSION_REVOKED');

    // Reuse revokes the whole family, including the newest token.
    const afterReuse = await api().post('/api/auth/refresh').set(XHR).set('Cookie', next);
    assert.equal(afterReuse.status, 401);
  });

  it('requires the X-Requested-With header (CSRF defence)', async () => {
    const res = await api().post('/api/auth/refresh');
    assert.equal(res.status, 400);
  });

  it('logout revokes the refresh token', async () => {
    const user = await createUser('student');
    const res = await api().post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    const cookie = refreshCookie(res).split(';')[0];
    assert.equal((await api().post('/api/auth/logout').set(XHR).set('Cookie', cookie)).status, 200);
    assert.equal((await api().post('/api/auth/refresh').set(XHR).set('Cookie', cookie)).status, 401);
  });
});

describe('mandatory password reset for admin-created accounts', () => {
  it('returns a single-use reset token instead of a session until a new password is set', async () => {
    const user = await createUser('professor', { mustResetPassword: true });
    const res = await api().post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.passwordResetRequired, true);
    assert.equal(res.body.data.accessToken, undefined);
    assert.equal(refreshCookie(res)?.includes('miata_rt=;'), true, 'no session cookie is issued');
    const { resetToken } = res.body.data;

    const same = await api().post('/api/auth/reset-password').send({ token: resetToken, password: PASSWORD });
    assert.equal(same.status, 422, 'new password must differ from the old one');

    const ok = await api().post('/api/auth/reset-password').send({ token: resetToken, password: 'BrandNew123' });
    assert.equal(ok.status, 200);
    const reused = await api().post('/api/auth/reset-password').send({ token: resetToken, password: 'Another123' });
    assert.equal(reused.status, 400, 'reset tokens are single use');

    await login(user.email, 'BrandNew123');
  });
});

describe('forgot password', () => {
  it('responds identically for known and unknown emails and issues an expiring token', async () => {
    const user = await createUser('student');
    const known = await api().post('/api/auth/forgot-password').send({ email: user.email });
    const unknown = await api().post('/api/auth/forgot-password').send({ email: 'ghost@test.local' });
    assert.equal(known.status, 200);
    assert.deepEqual(known.body, unknown.body);

    const { rows } = await pool.query(
      `SELECT expires_at > now() AS valid, purpose FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL`,
      [user.id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].valid, true);
  });

  it('rejects expired tokens', async () => {
    const user = await createUser('student');
    const res = await api().post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    assert.equal(res.status, 200);
    await pool.query(`UPDATE users SET must_reset_password = TRUE WHERE id = $1`, [user.id]);
    const forced = await api().post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    await pool.query(`UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [user.id]);
    const expired = await api().post('/api/auth/reset-password').send({ token: forced.body.data.resetToken, password: 'BrandNew123' });
    assert.equal(expired.status, 400);
    assert.equal(expired.body.error.code, 'INVALID_RESET_TOKEN');
  });
});

describe('registration', () => {
  it('registers a student through a referral link and attributes the agent', async () => {
    const agent = await createUser('agent');
    const { rows } = await pool.query('SELECT referral_code FROM agent_profiles WHERE user_id = $1', [agent.id]);
    const code = rows[0].referral_code;

    const lookup = await api().get(`/api/auth/referral/${code}`);
    assert.equal(lookup.body.data.valid, true);

    const res = await api().post('/api/auth/register').send({
      fullName: 'New Student',
      email: 'new.student@test.local',
      password: 'Student123',
      referralCode: code.toLowerCase(),
      acceptTerms: true,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.user.role, 'student');
    assert.ok(res.body.data.accessToken);

    const referral = await pool.query('SELECT agent_id, source FROM agent_referrals WHERE student_id = $1', [res.body.data.user.id]);
    assert.equal(referral.rows[0].agent_id, agent.id);
    assert.equal(referral.rows[0].source, 'link');
  });

  it('rejects invalid referral codes, duplicate emails and weak passwords', async () => {
    const base = { fullName: 'X Y', password: 'Student123', acceptTerms: true };
    const badCode = await api()
      .post('/api/auth/register')
      .send({ ...base, email: 'a@test.local', referralCode: 'NOPE999' });
    assert.equal(badCode.status, 422);
    assert.ok(badCode.body.error.details.referralCode);

    await api()
      .post('/api/auth/register')
      .send({ ...base, email: 'dup@test.local' });
    const dup = await api()
      .post('/api/auth/register')
      .send({ ...base, email: 'DUP@test.local' });
    assert.equal(dup.status, 409);

    const weak = await api()
      .post('/api/auth/register')
      .send({ ...base, email: 'weak@test.local', password: 'short' });
    assert.equal(weak.status, 422);
  });
});

describe('change password', () => {
  it('ends every other session', async () => {
    const user = await createUser('agent');
    const other = await login(user.email);
    const current = await login(user.email);
    const res = await api()
      .post('/api/profile/password')
      .set('Authorization', `Bearer ${current.token}`)
      .send({ currentPassword: PASSWORD, newPassword: 'Changed1234' });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.accessToken, 'the current device gets a fresh session');

    const stale = await api().get('/api/auth/me').set('Authorization', `Bearer ${other.token}`);
    assert.equal(stale.status, 401);
    assert.equal(stale.body.error.code, 'SESSION_REVOKED');
  });
});
