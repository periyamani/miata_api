import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/config/db.js';
import { expireStudentAccounts } from '../src/services/accessExpiry.service.js';
import { addDays, today } from '../src/utils/dates.js';
import { api, closeDatabase, createCourse, createUser, enrol, PASSWORD, pdfBytes, resetDatabase, userWithToken } from './helpers.js';

// Course access periods (automatic deactivation), agent applications (Apply Now), student fees and payment proofs
// verified by admins (migration 013).

const pngBytes = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
const daysFromToday = (n) => addDays(today(), n);
const enrolmentOf = async (studentId, courseId) =>
  (await pool.query('SELECT * FROM course_enrolments WHERE student_id = $1 AND course_id = $2', [studentId, courseId])).rows[0];
const setPeriod = (studentId, startDate, endDate) =>
  pool.query('UPDATE course_enrolments SET start_date = $2, end_date = $3 WHERE student_id = $1', [studentId, startDate, endDate]);
const isActive = async (userId) => (await pool.query('SELECT is_active FROM users WHERE id = $1', [userId])).rows[0].is_active;
const loginAs = (email, role = 'student') => api().post('/api/auth/login').send({ email, password: PASSWORD, role });

let admin, agent, course, openCourse;

before(async () => {
  await resetDatabase();
  admin = await userWithToken('admin');
  agent = await userWithToken('agent', { fullName: 'Agent Smith' });
  course = await createCourse(admin.auth, { title: 'PG Diploma', durationValue: 3, durationUnit: 'months', feeAmount: 36000 });
  openCourse = await createCourse(admin.auth, { title: 'Open course', durationValue: null, durationUnit: null });
});
after(closeDatabase);

describe('course access period', () => {
  it('starts on the enrolment day and ends after the course duration', async () => {
    const s = await createUser('student');
    await enrol(admin.auth, course.id, [s.id]);
    const e = await enrolmentOf(s.id, course.id);
    assert.equal(e.start_date, today());
    const start = new Date(`${today()}T00:00:00Z`);
    start.setUTCMonth(start.getUTCMonth() + 3);
    start.setUTCDate(start.getUTCDate() - 1);
    assert.equal(e.end_date, start.toISOString().slice(0, 10), 'start + 3 months − 1 day');
    assert.equal(Number(e.fee_amount), 36000, "the course fee is copied to the student's enrolment");

    await enrol(admin.auth, openCourse.id, [s.id]);
    assert.equal((await enrolmentOf(s.id, openCourse.id)).end_date, null, 'a course without a duration never ends');
  });

  it("starts on the batch's start date when the course is taken with a batch", async () => {
    const s = await createUser('student');
    const batch = await api()
      .post('/api/admin/batches')
      .set(admin.auth)
      .send({ code: 'B-2026', name: 'Batch 2026', startDate: '2026-01-05', courseIds: [course.id] });
    assert.equal(batch.status, 201);
    const added = await api()
      .post(`/api/admin/batches/${batch.body.data.id}/students`)
      .set(admin.auth)
      .send({ studentIds: [s.id] });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const e = await enrolmentOf(s.id, course.id);
    assert.deepEqual([e.start_date, e.end_date], ['2026-01-05', '2026-04-04']);
  });

  it('deactivates a student the day after their last course ends, once, and ends their sessions', async () => {
    const s = await userWithToken('student', { fullName: 'Expiring Student' });
    await enrol(admin.auth, course.id, [s.user.id]);
    await setPeriod(s.user.id, daysFromToday(-90), daysFromToday(0));
    const check = () => expireStudentAccounts({ studentId: s.user.id });
    assert.deepEqual(await check(), [], 'access still runs today');

    await setPeriod(s.user.id, daysFromToday(-90), daysFromToday(-1));
    const expired = await check();
    assert.deepEqual(
      expired.map((x) => x.id),
      [s.user.id],
    );
    assert.equal(await isActive(s.user.id), false);
    const { rows } = await pool.query(
      `SELECT u.deactivated_reason, sp.access_expired_on FROM users u JOIN student_profiles sp ON sp.user_id = u.id WHERE u.id = $1`,
      [s.user.id],
    );
    assert.deepEqual(rows[0], { deactivated_reason: 'course_expired', access_expired_on: daysFromToday(-1) });

    const me = await api().get('/api/student/dashboard').set(s.auth);
    assert.equal(me.status, 401, 'the session ended');
    const res = await loginAs(s.user.email);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'ACCOUNT_DISABLED');
    assert.match(res.body.error.message, /course access period has ended/);

    const log = await pool.query(`SELECT 1 FROM activity_logs WHERE action = 'student.access_expired' AND entity_id = $1`, [s.user.id]);
    assert.equal(log.rowCount, 1);
    const note = await pool.query(`SELECT title, link FROM notifications WHERE user_id = $1 AND type = 'access_expired'`, [admin.user.id]);
    assert.equal(note.rows.at(-1).link, `/admin/students/${s.user.id}`);
    assert.deepEqual(await check(), [], 'deactivated once');
  });

  it('applies at sign-in even before the periodic check has run', async () => {
    const s = await createUser('student');
    await enrol(admin.auth, course.id, [s.id]);
    await setPeriod(s.id, daysFromToday(-60), daysFromToday(-2));
    const res = await loginAs(s.email);
    assert.equal(res.status, 403);
    assert.match(res.body.error.message, /course access period has ended/);
    assert.equal(await isActive(s.id), false);
  });

  it('never expires students who are not enrolled, or who have a course without an end', async () => {
    const notEnrolled = await createUser('student');
    const openEnded = await createUser('student');
    await enrol(admin.auth, course.id, [openEnded.id]);
    await enrol(admin.auth, openCourse.id, [openEnded.id]);
    await pool.query('UPDATE course_enrolments SET start_date = $2, end_date = $3 WHERE student_id = $1 AND course_id = $4', [
      openEnded.id,
      daysFromToday(-200),
      daysFromToday(-100),
      course.id,
    ]);
    await expireStudentAccounts();
    assert.equal(await isActive(notEnrolled.id), true);
    assert.equal(await isActive(openEnded.id), true);
  });

  it('keeps an account the admin reactivated, until a later end date passes', async () => {
    const s = await createUser('student');
    await enrol(admin.auth, course.id, [s.id]);
    await setPeriod(s.id, daysFromToday(-90), daysFromToday(-1));
    await expireStudentAccounts({ studentId: s.id });
    const reactivated = await api().patch(`/api/admin/students/${s.id}/status`).set(admin.auth).send({ isActive: true });
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.body.data.deactivatedReason, null);
    await expireStudentAccounts();
    assert.equal(await isActive(s.id), true, 'not deactivated again for the same end date');
    assert.equal((await loginAs(s.email)).status, 200);

    const deactivated = await api().patch(`/api/admin/students/${s.id}/status`).set(admin.auth).send({ isActive: false });
    assert.equal(deactivated.body.data.deactivatedReason, 'admin');
    assert.match((await loginAs(s.email)).body.error.message, /^Your account has been deactivated/);
  });

  it('lets admins change the access period: extending reactivates, ending in the past deactivates at once', async () => {
    const s = await createUser('student');
    await enrol(admin.auth, course.id, [s.id]);
    const e = await enrolmentOf(s.id, course.id);
    await setPeriod(s.id, daysFromToday(-90), daysFromToday(-1));
    await expireStudentAccounts({ studentId: s.id });

    const bad = await api()
      .put(`/api/admin/enrolments/${e.id}/schedule`)
      .set(admin.auth)
      .send({ startDate: daysFromToday(0), endDate: daysFromToday(-5) });
    assert.equal(bad.status, 422);
    assert.ok(bad.body.error.details.endDate);

    const extend = await api()
      .put(`/api/admin/enrolments/${e.id}/schedule`)
      .set(admin.auth)
      .send({ startDate: daysFromToday(-90), endDate: daysFromToday(30) });
    assert.equal(extend.status, 200);
    assert.deepEqual(extend.body.data, { accountReactivated: true, accountDeactivated: false });
    assert.equal(await isActive(s.id), true);

    const detail = await api().get(`/api/admin/students/${s.id}`).set(admin.auth);
    assert.equal(detail.body.data.access.accessEndsOn, daysFromToday(30));
    assert.equal(detail.body.data.enrolments[0].endDate, daysFromToday(30));

    const end = await api()
      .put(`/api/admin/enrolments/${e.id}/schedule`)
      .set(admin.auth)
      .send({ startDate: daysFromToday(-90), endDate: daysFromToday(-3) });
    assert.deepEqual(end.body.data, { accountReactivated: false, accountDeactivated: true });
    assert.equal(await isActive(s.id), false);

    const noEnd = await api()
      .put(`/api/admin/enrolments/${e.id}/schedule`)
      .set(admin.auth)
      .send({ startDate: daysFromToday(-90), endDate: null });
    assert.equal(noEnd.body.data.accountReactivated, true, 'no end date: access never ends');
  });
});

describe('agent applications (Apply Now)', () => {
  const application = (overrides = {}) => ({
    fullName: 'Applicant One',
    email: 'applicant.one@test.local',
    phone: '+61 400 000 001',
    temporaryPassword: 'Welcome123',
    city: 'Melbourne',
    country: 'Australia',
    qualification: 'B.Sc. Radiography',
    courseId: course.id,
    notes: 'Prefers the evening batch',
    ...overrides,
  });

  it('lists the courses an agent can apply for', async () => {
    const res = await api().get('/api/agent/apply').set(agent.auth);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.courses.map((c) => c.id).sort(), [course.id, openCourse.id].sort());
    assert.equal(typeof res.body.data.emailConfigured, 'boolean');
    assert.equal(res.body.data.currency, 'AUD');
  });

  it('registers the student, links them to the agent and tells the admins', async () => {
    const res = await api().post('/api/agent/students').set(agent.auth).send(application());
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const { id, studentCode, welcomeEmail } = res.body.data;
    assert.match(studentCode, /^STU\d+$/);
    assert.ok(['sent', 'failed', 'skipped'].includes(welcomeEmail.status));

    const { rows } = await pool.query(
      'SELECT agent_id, source, applied_course_id, notes, created_by FROM agent_referrals WHERE student_id = $1',
      [id],
    );
    assert.deepEqual(rows[0], {
      agent_id: agent.user.id,
      source: 'agent',
      applied_course_id: course.id,
      notes: 'Prefers the evening batch',
      created_by: agent.user.id,
    });
    const user = await pool.query('SELECT role, must_reset_password FROM users WHERE id = $1', [id]);
    assert.deepEqual(user.rows[0], { role: 'student', must_reset_password: true }, 'the student chooses their own password');
    const enrolments = await pool.query('SELECT 1 FROM course_enrolments WHERE student_id = $1', [id]);
    assert.equal(enrolments.rowCount, 0, 'enrolment stays with MIATA');

    const mine = await api().get('/api/agent/students').set(agent.auth);
    const listed = mine.body.data.find((r) => r.studentId === id);
    assert.equal(listed.status, 'pending');
    assert.equal(listed.source, 'agent');
    assert.equal(listed.appliedCourseTitle, 'PG Diploma');

    const note = await pool.query(`SELECT title, link FROM notifications WHERE user_id = $1 AND link = $2`, [
      admin.user.id,
      `/admin/students/${id}`,
    ]);
    assert.match(note.rows[0].title, /New application from Agent Smith: Applicant One/);
    const detail = await api().get(`/api/admin/students/${id}`).set(admin.auth);
    assert.equal(detail.body.data.referral.source, 'agent');
    assert.equal(detail.body.data.referral.appliedCourseTitle, 'PG Diploma');
  });

  it('rejects duplicates, inactive courses and other roles', async () => {
    const dup = await api().post('/api/agent/students').set(agent.auth).send(application());
    assert.equal(dup.status, 409);
    const inactive = await createCourse(admin.auth, { title: 'Old course', isActive: false });
    const bad = await api()
      .post('/api/agent/students')
      .set(agent.auth)
      .send(application({ email: 'applicant.two@test.local', courseId: inactive.id }));
    assert.equal(bad.status, 422);
    assert.ok(bad.body.error.details.courseId);
    const student = await userWithToken('student');
    assert.equal(
      (
        await api()
          .post('/api/agent/students')
          .set(student.auth)
          .send(application({ email: 'x@test.local' }))
      ).status,
      403,
    );
  });

  it('cannot attribute the student to another agent', async () => {
    const other = await userWithToken('agent');
    const res = await api()
      .post('/api/agent/students')
      .set(agent.auth)
      .send({ ...application({ email: 'applicant.three@test.local' }), agentId: other.user.id });
    assert.equal(res.status, 201);
    const { rows } = await pool.query('SELECT agent_id FROM agent_referrals WHERE student_id = $1', [res.body.data.id]);
    assert.equal(rows[0].agent_id, agent.user.id);
  });
});

describe('fees and payment proofs', () => {
  let student, other, enrolmentId, paymentId;
  const submit = (who, fields, file = { bytes: pngBytes(), filename: 'transfer.png', contentType: 'image/png' }) => {
    const req = api().post('/api/student/payments').set(who.auth);
    for (const [k, v] of Object.entries({ courseId: course.id, amount: '10000', paidOn: today(), method: 'bank_transfer', ...fields })) {
      if (v !== undefined) req.field(k, String(v));
    }
    return req.attach('proof', file.bytes, { filename: file.filename, contentType: file.contentType });
  };
  const feesOf = async (who) => (await api().get('/api/student/fees').set(who.auth)).body.data;

  before(async () => {
    student = await userWithToken('student', { fullName: 'Paying Student' });
    other = await userWithToken('student', { fullName: 'Other Student' });
    await enrol(admin.auth, course.id, [student.user.id, other.user.id]);
    enrolmentId = (await enrolmentOf(student.user.id, course.id)).id;
    const settings = await api()
      .put('/api/admin/settings/fees')
      .set(admin.auth)
      .send({ currency: 'aud', paymentInstructions: 'BSB 062-000, account 1234 5678' });
    assert.equal(settings.status, 200);
    assert.equal(settings.body.data.fees.currency, 'AUD');
  });

  it('lets admins set the fee and a discount for the student', async () => {
    const tooMuch = await api()
      .put(`/api/admin/enrolments/${enrolmentId}/fee`)
      .set(admin.auth)
      .send({ feeAmount: 36000, discountAmount: 40000 });
    assert.equal(tooMuch.status, 422);
    const res = await api()
      .put(`/api/admin/enrolments/${enrolmentId}/fee`)
      .set(admin.auth)
      .send({ feeAmount: 36000, discountAmount: 6000 });
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.data.payable, res.body.data.balance], [30000, 30000]);
  });

  it('shows the student their fees, balance and how to pay', async () => {
    const fees = await feesOf(student);
    assert.equal(fees.currency, 'AUD');
    assert.equal(fees.paymentInstructions, 'BSB 062-000, account 1234 5678');
    assert.deepEqual(fees.totals, { payable: 30000, paid: 0, pending: 0, balance: 30000 });
    assert.deepEqual(
      fees.courses.map((c) => [c.courseTitle, c.feeAmount, c.discountAmount, c.balance]),
      [['PG Diploma', 36000, 6000, 30000]],
    );
    const dash = await api().get('/api/student/dashboard').set(student.auth);
    assert.equal(dash.body.data.fees.balance, 30000);
    assert.ok(dash.body.data.accessEndsOn);
  });

  it('accepts a payment proof as pending, and checks amount, date, course and file type', async () => {
    const res = await submit(student, { amount: '10000.50', reference: 'TRF-1', notes: 'First instalment' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    paymentId = res.body.data.id;
    assert.equal(res.body.data.status, 'pending');
    assert.equal(res.body.data.amount, 10000.5);
    assert.equal(res.body.data.proofName, 'transfer.png');

    const fees = await feesOf(student);
    assert.deepEqual(fees.totals, { payable: 30000, paid: 0, pending: 10000.5, balance: 30000 }, 'pending is not paid yet');

    const tooMuch = await submit(student, { amount: '25000' });
    assert.equal(tooMuch.status, 422, 'balance less pending is 19,999.50');
    assert.ok(tooMuch.body.error.details.amount);
    assert.equal((await submit(student, { paidOn: daysFromToday(3) })).status, 422);
    assert.equal((await submit(student, { amount: '0' })).status, 422);
    assert.equal((await submit(student, { courseId: openCourse.id })).status, 422, 'not enrolled');
    const fake = await submit(student, {}, { bytes: Buffer.from('MZ not an image'), filename: 'proof.png', contentType: 'image/png' });
    assert.equal(fake.status, 415);
    const pdf = await submit(student, { amount: '100' }, { bytes: pdfBytes(), filename: 'receipt.pdf', contentType: 'application/pdf' });
    assert.equal(pdf.status, 201, 'PDF receipts are accepted');
    await pool.query('DELETE FROM fee_payments WHERE id = $1', [pdf.body.data.id]);

    const note = await pool.query(`SELECT link FROM notifications WHERE user_id = $1 AND type = 'payment_submitted'`, [admin.user.id]);
    assert.ok(note.rows.some((n) => n.link === `/admin/payments/${paymentId}`));
  });

  it('keeps proofs private to the student and admins', async () => {
    assert.equal((await api().get(`/api/student/payments/${paymentId}/proof`).set(student.auth)).status, 200);
    assert.equal((await api().get(`/api/student/payments/${paymentId}/proof`).set(other.auth)).status, 404);
    const proof = await api().get(`/api/admin/payments/${paymentId}/proof`).set(admin.auth).buffer(true);
    assert.equal(proof.status, 200);
    assert.equal(proof.headers['content-type'], 'image/png');
    assert.equal((await api().get('/api/admin/payments').set(student.auth)).status, 403);
  });

  it('lists payments for verification with their fee position', async () => {
    const list = await api().get('/api/admin/payments').query({ status: 'pending' }).set(admin.auth);
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.data.map((p) => p.id),
      [paymentId],
    );
    assert.equal(list.body.meta.currency, 'AUD');
    assert.equal(list.body.data[0].studentName, 'Paying Student');
    const stats = await api().get('/api/admin/payments/stats').set(admin.auth);
    assert.equal(stats.body.data.pendingCount, 1);
    const detail = await api().get(`/api/admin/payments/${paymentId}`).set(admin.auth);
    assert.deepEqual(
      [detail.body.data.fees.payable, detail.body.data.fees.pending, detail.body.data.fees.balance],
      [30000, 10000.5, 30000],
    );
    const dash = await api().get('/api/admin/dashboard').set(admin.auth);
    assert.equal(dash.body.data.stats.pendingPayments, 1);
  });

  it('approving a payment lowers the balance; rejecting needs a reason; pending undoes a decision', async () => {
    const noReason = await api().patch(`/api/admin/payments/${paymentId}/status`).set(admin.auth).send({ status: 'rejected' });
    assert.equal(noReason.status, 422);
    assert.ok(noReason.body.error.details.note);

    const approved = await api().patch(`/api/admin/payments/${paymentId}/status`).set(admin.auth).send({ status: 'approved' });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.data.status, 'approved');
    assert.ok(approved.body.data.reviewedAt);
    assert.deepEqual([approved.body.data.fees.paid, approved.body.data.fees.balance], [10000.5, 19999.5]);
    assert.deepEqual((await feesOf(student)).totals, { payable: 30000, paid: 10000.5, pending: 0, balance: 19999.5 });
    const told = await pool.query(`SELECT title, body FROM notifications WHERE user_id = $1 AND type = 'payment_approved'`, [
      student.user.id,
    ]);
    assert.match(told.rows[0].title, /approved/);

    const reopened = await api().patch(`/api/admin/payments/${paymentId}/status`).set(admin.auth).send({ status: 'pending' });
    assert.equal(reopened.body.data.status, 'pending');
    assert.equal(reopened.body.data.reviewedAt, null);
    assert.equal(reopened.body.data.fees.balance, 30000);

    const rejected = await api()
      .patch(`/api/admin/payments/${paymentId}/status`)
      .set(admin.auth)
      .send({ status: 'rejected', note: 'Transfer not received' });
    assert.equal(rejected.body.data.status, 'rejected');
    const mine = await feesOf(student);
    assert.equal(mine.payments[0].reviewNote, 'Transfer not received');
    assert.deepEqual(mine.totals, { payable: 30000, paid: 0, pending: 0, balance: 30000 });

    const log = await pool.query(
      `SELECT action, metadata->>'previousStatus' AS previous FROM activity_logs WHERE entity_type = 'payment' AND entity_id = $1 ORDER BY id`,
      [paymentId],
    );
    assert.deepEqual(
      log.rows.map((r) => [r.action, r.previous]),
      [
        ['payment.submitted', null],
        ['payment.approved', 'pending'],
        ['payment.reopened', 'approved'],
        ['payment.rejected', 'pending'],
      ],
    );
  });

  it("shows fees and payments on the admin's student page and keeps paid enrolments", async () => {
    const approvedRes = await submit(student, { amount: '5000' });
    await api().patch(`/api/admin/payments/${approvedRes.body.data.id}/status`).set(admin.auth).send({ status: 'approved' });
    const detail = await api().get(`/api/admin/students/${student.user.id}`).set(admin.auth);
    assert.deepEqual(detail.body.data.fees, { currency: 'AUD', payable: 30000, paid: 5000, pending: 0, balance: 25000 });
    assert.equal(detail.body.data.payments.length, 2);
    assert.equal(detail.body.data.enrolments[0].balance, 25000);

    const remove = await api().delete(`/api/admin/enrolments/${enrolmentId}`).set(admin.auth);
    assert.equal(remove.status, 409);
    assert.match(remove.body.error.message, /Fee payments/);
  });

  it('copies the course fee to new enrolments only', async () => {
    const res = await api()
      .put(`/api/admin/courses/${course.id}`)
      .set(admin.auth)
      .send({ code: course.code, title: course.title, durationValue: 3, durationUnit: 'months', feeAmount: 40000, isActive: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.feeAmount, 40000);
    const late = await createUser('student');
    await enrol(admin.auth, course.id, [late.id]);
    assert.equal(Number((await enrolmentOf(late.id, course.id)).fee_amount), 40000);
    assert.equal(Number((await enrolmentOf(student.user.id, course.id)).fee_amount), 36000, 'existing students keep their fee');
  });
});
