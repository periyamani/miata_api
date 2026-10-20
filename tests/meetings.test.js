import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closeSmtpSink, inbox, mailFor, rejectRecipients, startSmtpSink } from './smtp-sink.js';

// E-mail is delivered for real (nodemailer → local SMTP sink), so these tests check exactly who receives what.
await startSmtpSink();
// Loaded only now, so config/env.js sees the SMTP sink.
const { pool } = await import('../src/config/db.js');
const { api, closeDatabase, login, resetDatabase, userWithToken } = await import('./helpers.js');

let admin, prof, otherProf, s1, s2, s3, outsider, inactive, batchA, batchB;

async function createBatch(code, { professorIds = [], studentIds = [] } = {}) {
  const { rows } = await pool.query('INSERT INTO batches (code, name) VALUES ($1, $2) RETURNING id', [code, `Batch ${code}`]);
  for (const p of professorIds) await pool.query('INSERT INTO batch_professors (batch_id, professor_id) VALUES ($1, $2)', [rows[0].id, p]);
  for (const s of studentIds) await pool.query('INSERT INTO batch_students (batch_id, student_id) VALUES ($1, $2)', [rows[0].id, s]);
  return rows[0].id;
}

/** Meeting e-mails are sent after the response: wait until none is pending. */
async function settle() {
  for (let i = 0; i < 100; i += 1) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM email_deliveries WHERE status = 'pending'`);
    if (!rows[0].n) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('E-mails are still pending');
}

const inHours = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString();
const LINK = 'https://meet.google.com/abc-defg-hij';
const meetingBody = (fields = {}) => ({
  batchId: batchA,
  title: 'Abdominal scanning Q&A',
  meetingUrl: LINK,
  startsAt: inHours(48),
  durationMinutes: 60,
  ...fields,
});
const schedule = (who, fields) => api().post('/api/professor/meetings').set(who.auth).send(meetingBody(fields));
const studentMeetings = async (who, when = 'upcoming') => (await api().get(`/api/student/meetings?when=${when}`).set(who.auth)).body.data;
const setupToken = (message) => decodeURIComponent(message.text.match(/reset-password\?token=([A-Za-z0-9_%-]+)/)[1]);

before(async () => {
  await resetDatabase();
  admin = await userWithToken('admin');
  prof = await userWithToken('professor');
  otherProf = await userWithToken('professor');
  s1 = await userWithToken('student');
  s2 = await userWithToken('student');
  s3 = await userWithToken('student');
  outsider = await userWithToken('student');
  inactive = await userWithToken('student');
  batchA = await createBatch('MEET-A', { professorIds: [prof.user.id], studentIds: [s1.user.id, s2.user.id, inactive.user.id] });
  batchB = await createBatch('MEET-B', { professorIds: [otherProf.user.id], studentIds: [s3.user.id] });
  await pool.query('UPDATE users SET is_active = FALSE WHERE id = $1', [inactive.user.id]);
});
after(async () => {
  await closeDatabase();
  await closeSmtpSink();
});

describe('account e-mails', () => {
  it('sends a new student their account details and a set-password link, never a password', async () => {
    const res = await api()
      .post('/api/admin/students')
      .set(admin.auth)
      .send({ fullName: 'Asha Rao', email: 'asha.rao@test.local', temporaryPassword: 'Temporary123' });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.welcomeEmail.status, 'sent');

    const mail = mailFor('asha.rao@test.local');
    assert.equal(mail.length, 1);
    assert.deepEqual(mail[0].to, ['asha.rao@test.local'], 'one recipient only');
    assert.match(mail[0].text, /Asha Rao/);
    assert.match(mail[0].text, /STU\d+/, 'includes the student ID');
    assert.match(mail[0].text, /\/login\/student/, 'includes sign-in instructions');
    assert.ok(!mail[0].text.includes('Temporary123'), 'the temporary password is never e-mailed');
  });

  it('lets the new account choose its password through the link, which works once', async () => {
    const res = await api().post('/api/admin/students').set(admin.auth).send({ fullName: 'Ben Das', email: 'ben.das@test.local' });
    assert.equal(res.status, 201, 'the temporary password is optional when e-mail works');
    const token = setupToken(mailFor('ben.das@test.local')[0]);

    const verify = await api().post('/api/auth/reset-password/verify').send({ token });
    assert.equal(verify.status, 200);
    assert.equal(verify.body.data.purpose, 'setup');
    assert.equal((await api().post('/api/auth/reset-password').send({ token, password: 'MyOwnPass1' })).status, 200);
    await login('ben.das@test.local', 'MyOwnPass1');
    assert.equal((await api().post('/api/auth/reset-password').send({ token, password: 'Another123' })).status, 400, 'single use');
  });

  it('sends a new professor their own welcome e-mail', async () => {
    const res = await api().post('/api/admin/professors').set(admin.auth).send({ fullName: 'Dr Chen', email: 'dr.chen@test.local' });
    assert.equal(res.status, 201);
    const mail = mailFor('dr.chen@test.local');
    assert.equal(mail.length, 1);
    assert.match(mail[0].text, /Professor/);
    assert.match(mail[0].text, /PRF\d+/, 'includes the employee ID');
  });

  it('reports a failed welcome e-mail and lets the admin send a new link', async () => {
    rejectRecipients.add('fail.once@test.local');
    const res = await api().post('/api/admin/students').set(admin.auth).send({ fullName: 'Fail Once', email: 'fail.once@test.local' });
    assert.equal(res.status, 201, 'the account is still created');
    assert.equal(res.body.data.welcomeEmail.status, 'failed');
    assert.ok(res.body.data.welcomeEmail.error);

    rejectRecipients.delete('fail.once@test.local');
    const resend = await api().post(`/api/admin/students/${res.body.data.id}/setup-email`).set(admin.auth);
    assert.equal(resend.status, 200);
    assert.equal(resend.body.data.status, 'sent');
    assert.equal(mailFor('fail.once@test.local').length, 1);
    const { rows } = await pool.query(`SELECT kind, status FROM email_deliveries WHERE recipient = 'fail.once@test.local' ORDER BY id`);
    assert.deepEqual(
      rows.map((r) => `${r.kind}:${r.status}`),
      ['account_created:failed', 'account_setup:sent'],
    );
  });

  it('rejects invalid addresses before creating the account', async () => {
    const res = await api().post('/api/admin/students').set(admin.auth).send({ fullName: 'No Mail', email: 'not-an-email' });
    assert.equal(res.status, 422);
    assert.ok(res.body.error.details.email);
  });
});

describe('scheduling online classes', () => {
  let meeting;

  it('only lets professors schedule for their own batches, with a Google Meet or Zoom link in the future', async () => {
    const cases = [
      [{ batchId: batchB }, 'batchId'],
      [{ meetingUrl: 'https://example.com/meeting' }, 'meetingUrl'],
      [{ meetingUrl: 'http://meet.google.com/abc-defg-hij' }, 'meetingUrl'],
      [{ meetingUrl: 'javascript:alert(1)' }, 'meetingUrl'],
      [{ startsAt: inHours(-1) }, 'startsAt'],
      [{ audience: 'selected', studentIds: [] }, 'studentIds'],
      [{ audience: 'selected', studentIds: [s3.user.id] }, 'studentIds'],
    ];
    for (const [fields, field] of cases) {
      const res = await schedule(prof, fields);
      assert.equal(res.status, 422, JSON.stringify(fields));
      assert.ok(res.body.error.details[field], `${JSON.stringify(fields)} → ${field}`);
    }
    assert.equal(inbox.filter((m) => m.text.includes(LINK)).length, 0, 'nothing is sent for rejected requests');
  });

  it('invites exactly the active students of the batch, one e-mail each', async () => {
    const res = await schedule(prof);
    assert.equal(res.status, 201);
    meeting = res.body.data;
    assert.equal(meeting.platform, 'google_meet');
    assert.deepEqual(meeting.notified, { scheduled: 2 });
    await settle();

    for (const who of [s1, s2]) {
      const mail = mailFor(who.user.email);
      assert.equal(mail.length, 1, `${who.user.email} is invited once`);
      assert.deepEqual(mail[0].to, [who.user.email], 'students never see each other’s addresses');
      assert.ok(mail[0].text.includes(LINK));
      assert.ok(mail[0].text.includes(prof.user.full_name));
      assert.ok(mail[0].text.includes('Batch MEET-A'));
    }
    for (const who of [s3, outsider, inactive]) assert.equal(mailFor(who.user.email).length, 0, `${who.user.email} is not invited`);

    const { rows } = await pool.query(`SELECT type FROM notifications WHERE user_id = $1`, [s1.user.id]);
    assert.ok(
      rows.some((n) => n.type === 'meeting_scheduled'),
      'in-app notification too',
    );
  });

  it('shows the meeting to the batch only', async () => {
    const [seen] = await studentMeetings(s1);
    assert.equal(seen.id, meeting.id);
    assert.equal(seen.meetingUrl, LINK);
    assert.equal(seen.professorName, prof.user.full_name);
    assert.equal(seen.batchName, 'Batch MEET-A');
    assert.equal((await studentMeetings(s3)).length, 0);
    assert.equal((await studentMeetings(outsider)).length, 0);

    const dashboard = await api().get('/api/student/dashboard').set(s1.auth);
    assert.equal(dashboard.body.data.upcomingMeetings[0].id, meeting.id);
    const profDashboard = await api().get('/api/professor/dashboard').set(prof.auth);
    assert.equal(profDashboard.body.data.upcomingMeetings[0].id, meeting.id);
  });

  it('keeps meetings private to their organiser', async () => {
    assert.equal((await api().get(`/api/professor/meetings/${meeting.id}`).set(otherProf.auth)).status, 404);
    assert.equal((await api().put(`/api/professor/meetings/${meeting.id}`).set(otherProf.auth).send(meetingBody())).status, 404);
    assert.equal((await api().post(`/api/professor/meetings/${meeting.id}/cancel`).set(otherProf.auth).send({})).status, 404);
    assert.equal((await api().get(`/api/professor/meetings/batches/${batchA}/students`).set(otherProf.auth)).status, 404);
    assert.equal((await api().get('/api/professor/meetings').set(otherProf.auth)).body.data.length, 0);

    const students = await api().get(`/api/professor/meetings/batches/${batchA}/students`).set(prof.auth);
    assert.deepEqual(students.body.data.map((s) => s.id).sort(), [s1.user.id, s2.user.id].sort(), 'inactive accounts are not offered');
    const detail = await api().get(`/api/professor/meetings/${meeting.id}`).set(prof.auth);
    assert.equal(detail.body.data.recipients.length, 2);
    assert.ok(
      detail.body.data.recipients.every((r) => r.emailStatus === 'sent' && r.email === undefined),
      'no addresses for professors',
    );
  });

  it('sends nothing when a meeting is saved without changes', async () => {
    const before = inbox.length;
    const res = await api()
      .put(`/api/professor/meetings/${meeting.id}`)
      .set(prof.auth)
      .send(meetingBody({ startsAt: meeting.startsAt }));
    assert.equal(res.status, 200);
    assert.equal(res.body.data.unchanged, true);
    await settle();
    assert.equal(inbox.length, before);
  });

  it('tells every invited student once when the time or link changes', async () => {
    const before = inbox.length;
    const res = await api()
      .put(`/api/professor/meetings/${meeting.id}`)
      .set(prof.auth)
      .send(meetingBody({ startsAt: inHours(72), meetingUrl: 'https://us02web.zoom.us/j/81234567890' }));
    assert.equal(res.status, 200);
    assert.equal(res.body.data.platform, 'zoom');
    assert.deepEqual(res.body.data.notified, { scheduled: 0, cancelled: 0, updated: 2 });
    await settle();
    const updates = inbox.slice(before);
    assert.equal(updates.length, 2);
    for (const mail of updates) {
      assert.match(mail.text, /What changed: Date and time, Meeting link/);
      assert.ok(mail.text.includes('https://us02web.zoom.us/j/81234567890'));
    }
  });

  it('when the audience narrows, tells removed students (without the link) and nobody else', async () => {
    const before = inbox.length;
    const current = (await api().get(`/api/professor/meetings/${meeting.id}`).set(prof.auth)).body.data;
    const res = await api()
      .put(`/api/professor/meetings/${meeting.id}`)
      .set(prof.auth)
      .send(meetingBody({ startsAt: current.startsAt, meetingUrl: current.meetingUrl, audience: 'selected', studentIds: [s1.user.id] }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.notified, { scheduled: 0, cancelled: 1 });
    await settle();
    const sent = inbox.slice(before);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, [s2.user.email]);
    assert.match(sent[0].text, /no longer scheduled for you/);
    assert.ok(!sent[0].text.includes('zoom.us/j/'), 'removed students do not get the link');
    assert.equal((await studentMeetings(s2)).length, 0, 'and can no longer see the meeting');
    assert.equal((await studentMeetings(s1)).length, 1);
  });

  it('cancels with a notice to the audience and withholds the link afterwards', async () => {
    const before = inbox.length;
    const res = await api().post(`/api/professor/meetings/${meeting.id}/cancel`).set(prof.auth).send({ reason: 'Professor unwell' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'cancelled');
    await settle();
    const sent = inbox.slice(before);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, [s1.user.email]);
    assert.match(sent[0].text, /cancelled/);
    assert.match(sent[0].text, /Professor unwell/);
    assert.ok(!sent[0].text.includes('zoom.us/j/'));

    const [seen] = await studentMeetings(s1);
    assert.equal(seen.status, 'cancelled');
    assert.equal(seen.meetingUrl, null);
    assert.equal((await api().post(`/api/professor/meetings/${meeting.id}/cancel`).set(prof.auth).send({})).status, 409);
    assert.equal((await api().put(`/api/professor/meetings/${meeting.id}`).set(prof.auth).send(meetingBody())).status, 409);
  });

  it('records failed deliveries and resends them once, without duplicating sent ones', async () => {
    rejectRecipients.add(s2.user.email);
    const created = await schedule(prof, { title: 'Physics revision', startsAt: inHours(24) });
    await settle();
    let detail = (await api().get(`/api/professor/meetings/${created.body.data.id}`).set(prof.auth)).body.data;
    const status = Object.fromEntries(detail.recipients.map((r) => [r.studentId, r]));
    assert.equal(status[s1.user.id].emailStatus, 'sent');
    assert.equal(status[s2.user.id].emailStatus, 'failed');
    assert.equal(status[s2.user.id].emailRetryable, true);
    assert.deepEqual(detail.emails, { sent: 1, pending: 0, failed: 1, skipped: 0 });

    const stillFailing = await api().post(`/api/professor/meetings/${detail.id}/resend`).set(prof.auth);
    assert.deepEqual([stillFailing.body.data.retried, stillFailing.body.data.failed], [1, 1]);

    rejectRecipients.delete(s2.user.email);
    const before = mailFor(s2.user.email).length;
    const resent = await api().post(`/api/professor/meetings/${detail.id}/resend`).set(prof.auth);
    assert.deepEqual([resent.body.data.retried, resent.body.data.sent], [1, 1]);
    assert.equal(mailFor(s2.user.email).length, before + 1);
    assert.ok(mailFor(s2.user.email).at(-1).text.includes('Physics revision'));

    const again = await api().post(`/api/professor/meetings/${detail.id}/resend`).set(prof.auth);
    assert.equal(again.body.data.retried, 0, 'nothing left to resend');
    detail = (await api().get(`/api/professor/meetings/${detail.id}`).set(prof.auth)).body.data;
    assert.deepEqual(detail.emails, { sent: 2, pending: 0, failed: 0, skipped: 0 });
    const { rows } = await pool.query(
      `SELECT dedupe_key, count(*)::int AS n FROM email_deliveries WHERE meeting_id = $1 GROUP BY dedupe_key HAVING count(*) > 1`,
      [detail.id],
    );
    assert.equal(rows.length, 0, 'one row per notification');
  });

  it('lets admins monitor every meeting (read-only), with recipient addresses', async () => {
    const list = await api().get('/api/admin/meetings?when=cancelled').set(admin.auth);
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.data.map((m) => m.id),
      [meeting.id],
    );
    const detail = await api().get(`/api/admin/meetings/${meeting.id}`).set(admin.auth);
    assert.equal(detail.body.data.recipients[0].email, s1.user.email);
    assert.equal((await api().post('/api/admin/meetings').set(admin.auth).send(meetingBody())).status, 404);
    assert.equal((await api().get('/api/admin/meetings').set(prof.auth)).status, 403);
    assert.equal((await api().get('/api/student/meetings').set(prof.auth)).status, 403);
  });
});
