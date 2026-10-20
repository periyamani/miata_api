import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/config/db.js';
import {
  ageHeartbeat,
  api,
  assignProfessor,
  closeDatabase,
  createAssignment,
  createCourse,
  enrol,
  login,
  pdfBytes,
  resetDatabase,
  userWithToken,
  uploadVideo,
  watchVideo,
} from './helpers.js';

const XHR = { 'X-Requested-With': 'XMLHttpRequest' };
let admin, professor;

async function setPolicy(overrides) {
  const res = await api()
    .put('/api/admin/settings/completion-policy')
    .set(admin.auth)
    .send({
      requireAllVideos: true,
      requireAllAssignments: true,
      videoWatchThreshold: 90,
      logoutOnCompletion: true,
      passwordResetOnCompletion: 'next_login',
      ...overrides,
    });
  assert.equal(res.status, 200);
}

/** A course with one 60-second video and one assignment, and an enrolled student. */
async function scenario() {
  const course = await createCourse(admin.auth);
  await assignProfessor(admin.auth, course.id, professor.user.id);
  const video = await uploadVideo(admin.auth, { courseId: course.id, seconds: 60 });
  const assignment = await createAssignment(professor.auth, { courseId: course.id });
  const student = await userWithToken('student');
  await enrol(admin.auth, course.id, [student.user.id]);
  return { course, video, assignment, student };
}

async function submitAndApprove(student, assignment) {
  const sub = await api()
    .post(`/api/student/assignments/${assignment.id}/submissions`)
    .set(student.auth)
    .attach('file', pdfBytes(), { filename: 'work.pdf', contentType: 'application/pdf' });
  assert.equal(sub.status, 201);
  return api()
    .post(`/api/professor/submissions/${sub.body.data.latestSubmissionId}/review`)
    .set(professor.auth)
    .send({ decision: 'completed' });
}

before(async () => {
  await resetDatabase();
  admin = await userWithToken('admin');
  professor = await userWithToken('professor');
});
beforeEach(() => setPolicy({}));
after(closeDatabase);

describe('video progress is credited server-side', () => {
  it('does not complete a video when the student skips to the end', async () => {
    const { video, student } = await scenario();
    await api().post(`/api/student/videos/${video.id}/progress`).set(student.auth).send({ position: 0 }).expect(200);
    await ageHeartbeat(video.id, student.user.id, 10);
    const res = await api().post(`/api/student/videos/${video.id}/progress`).set(student.auth).send({ position: 60 });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.videoCompleted, false);
    assert.equal(res.body.data.watchedSeconds, 0);
  });

  it('completes a video watched in real time', async () => {
    const { video, student } = await scenario();
    const res = await watchVideo(student.auth, student.user.id, video);
    assert.equal(res.body.data.videoCompleted, true);
  });

  it('records no progress for unpublished videos', async () => {
    const { course, student } = await scenario();
    const draft = await uploadVideo(admin.auth, { courseId: course.id, published: false });
    const res = await api().post(`/api/student/videos/${draft.id}/progress`).set(student.auth).send({ position: 5 });
    assert.equal(res.status, 404);
  });
});

describe('course completion workflow', () => {
  it('is never completed by a student request', async () => {
    const { course, student } = await scenario();
    for (const path of [`/api/student/courses/${course.id}/complete`, `/api/student/completion`]) {
      const res = await api().post(path).set(student.auth);
      assert.equal(res.status, 404, path);
    }
  });

  it('does not complete until every requirement is met', async () => {
    const { course, assignment, student } = await scenario();
    const res = await submitAndApprove(student, assignment);
    assert.equal(res.body.data.courseCompleted, false, 'the video has not been watched yet');
    const completion = await api().get('/api/student/completion').set(student.auth);
    const entry = completion.body.data.courses.find((c) => c.courseId === course.id);
    assert.equal(entry.status, 'active');
    assert.equal(entry.progress.percent, 50);
  });

  it('completes the course, logs the student out and forces a password reset at next login', async () => {
    const { course, video, assignment, student } = await scenario();
    const before = await login(student.user.email);

    await submitAndApprove(student, assignment);
    const res = await watchVideo(student.auth, student.user.id, video);
    assert.equal(res.body.data.courseCompleted, true);
    assert.equal(res.body.data.sessionEnded, true);
    assert.equal(res.body.data.passwordResetRequired, true);

    // Every existing access token and refresh token is dead.
    const me = await api().get('/api/auth/me').set(student.auth);
    assert.equal(me.status, 401);
    const refresh = await api()
      .post('/api/auth/refresh')
      .set(XHR)
      .set(
        'Cookie',
        before.cookie.map((c) => c.split(';')[0]),
      );
    assert.equal(refresh.status, 401);

    // The correct password yields a reset token only; the reset cannot be skipped.
    const loginRes = await api().post('/api/auth/login').send({ email: student.user.email, password: 'Testing123' });
    assert.equal(loginRes.body.data.passwordResetRequired, true);
    assert.equal(loginRes.body.data.reason, 'course_completed');
    assert.equal(loginRes.body.data.accessToken, undefined);

    const reset = await api().post('/api/auth/reset-password').send({ token: loginRes.body.data.resetToken, password: 'AfterCourse123' });
    assert.equal(reset.status, 200);

    // Completion records stay available after the reset.
    const fresh = await login(student.user.email, 'AfterCourse123');
    const completion = await api().get('/api/student/completion').set('Authorization', `Bearer ${fresh.token}`);
    const entry = completion.body.data.courses.find((c) => c.courseId === course.id);
    assert.equal(entry.status, 'completed');
    assert.ok(entry.completedAt);
    assert.equal(entry.progress.percent, 100);

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM activity_logs WHERE action = 'course.completed' AND entity_id = $1`, [
      course.id,
    ]);
    assert.equal(rows[0].n, 1, 'the completion event is recorded once');
  });

  it('keeps the session when the policy disables logout and reset', async () => {
    await setPolicy({ logoutOnCompletion: false, passwordResetOnCompletion: 'none', requireAllVideos: false });
    const { assignment, student } = await scenario();
    const res = await submitAndApprove(student, assignment);
    assert.equal(res.body.data.courseCompleted, true);
    assert.equal((await api().get('/api/auth/me').set(student.auth)).status, 200);
  });

  it('never auto-completes a course without requirements', async () => {
    await setPolicy({ requireAllAssignments: false });
    const course = await createCourse(admin.auth);
    const student = await userWithToken('student');
    await enrol(admin.auth, course.id, [student.user.id]);
    const completion = await api().get('/api/student/completion').set(student.auth);
    assert.equal(completion.body.data.courses[0].progress.criteriaMet, false);
  });

  it('validates the policy', async () => {
    const res = await api().put('/api/admin/settings/completion-policy').set(admin.auth).send({
      requireAllVideos: false,
      requireAllAssignments: false,
      videoWatchThreshold: 90,
      logoutOnCompletion: true,
      passwordResetOnCompletion: 'next_login',
    });
    assert.equal(res.status, 422);
  });
});
