import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/config/db.js';
import {
  api,
  assignProfessor,
  closeDatabase,
  createAssignment,
  createCourse,
  createModule,
  enrol,
  pdfBytes,
  resetDatabase,
  userWithToken,
} from './helpers.js';

let admin, courseProf, moduleProf, outsider, student, otherStudent, course, moduleA, moduleB, assignmentA, assignmentB;

const submit = (who, assignmentId, { bytes = pdfBytes(), filename = 'report.pdf', type = 'application/pdf' } = {}) =>
  api()
    .post(`/api/student/assignments/${assignmentId}/submissions`)
    .set(who.auth)
    .field('notes', 'My work')
    .attach('file', bytes, { filename, contentType: type });

before(async () => {
  await resetDatabase();
  admin = await userWithToken('admin');
  courseProf = await userWithToken('professor');
  moduleProf = await userWithToken('professor');
  outsider = await userWithToken('professor');
  student = await userWithToken('student');
  otherStudent = await userWithToken('student');

  course = await createCourse(admin.auth);
  moduleA = await createModule(admin.auth, course.id, 'Physics');
  moduleB = await createModule(admin.auth, course.id, 'Obstetrics');
  await assignProfessor(admin.auth, course.id, courseProf.user.id);
  const mod = await api().post(`/api/admin/modules/${moduleB.id}/professors`).set(admin.auth).send({ professorId: moduleProf.user.id });
  assert.equal(mod.status, 201);
  await enrol(admin.auth, course.id, [student.user.id, otherStudent.user.id]);
  assignmentA = await createAssignment(courseProf.auth, { courseId: course.id, moduleId: moduleA.id, title: 'Physics report' });
  assignmentB = await createAssignment(moduleProf.auth, { courseId: course.id, moduleId: moduleB.id, title: 'OB report' });
});
after(closeDatabase);

describe('student submissions', () => {
  it('only shows assignments of enrolled courses', async () => {
    const outsiderStudent = await userWithToken('student');
    assert.equal((await api().get(`/api/student/assignments/${assignmentA.id}`).set(outsiderStudent.auth)).status, 404);
    const res = await api().get('/api/student/assignments').set(student.auth);
    assert.equal(res.body.data.length, 2);
    assert.ok(res.body.data.every((a) => a.status === 'pending'));
  });

  it('rejects files whose content does not match the extension', async () => {
    const res = await submit(student, assignmentA.id, { bytes: Buffer.from('MZ fake executable'), filename: 'report.pdf' });
    assert.equal(res.status, 415);
  });

  it('rejects disallowed file types', async () => {
    const res = await submit(student, assignmentA.id, { bytes: Buffer.from('<script>'), filename: 'page.html', type: 'text/html' });
    assert.equal(res.status, 415);
  });

  it('accepts a valid upload as attempt 1 and blocks a second upload while pending', async () => {
    const res = await submit(student, assignmentA.id);
    assert.equal(res.status, 201);
    assert.equal(res.body.data.status, 'submitted');
    assert.equal(res.body.data.canSubmit, false);
    const again = await submit(student, assignmentA.id);
    assert.equal(again.status, 409);
  });
});

describe('professor scope', () => {
  let submissionId;
  before(async () => {
    const list = await api().get('/api/professor/submissions?status=pending').set(courseProf.auth);
    submissionId = list.body.data[0].id;
  });

  it('course professor sees the submission; module and unrelated professors do not', async () => {
    assert.equal((await api().get(`/api/professor/submissions/${submissionId}`).set(courseProf.auth)).status, 200);
    assert.equal((await api().get(`/api/professor/submissions/${submissionId}`).set(moduleProf.auth)).status, 404);
    assert.equal((await api().get(`/api/professor/submissions/${submissionId}`).set(outsider.auth)).status, 404);
    assert.equal((await api().get('/api/professor/submissions').set(outsider.auth)).body.meta.total, 0);
  });

  it('module professor can review their module’s assignment only', async () => {
    const res = await submit(otherStudent, assignmentB.id);
    assert.equal(res.status, 201);
    const list = await api().get('/api/professor/submissions').set(moduleProf.auth);
    assert.deepEqual(
      list.body.data.map((s) => s.assignmentId),
      [assignmentB.id],
    );
  });

  it('outsiders cannot download the file or review', async () => {
    assert.equal((await api().get(`/api/professor/submissions/${submissionId}/file`).set(outsider.auth)).status, 404);
    const review = await api().post(`/api/professor/submissions/${submissionId}/review`).set(outsider.auth).send({ decision: 'completed' });
    assert.equal(review.status, 404);
  });

  it('students cannot download each other’s files', async () => {
    assert.equal((await api().get(`/api/student/submissions/${submissionId}/file`).set(otherStudent.auth)).status, 404);
    const own = await api().get(`/api/student/submissions/${submissionId}/file`).set(student.auth);
    assert.equal(own.status, 200);
    assert.match(own.headers['content-disposition'], /attachment/);
  });
});

describe('review, comment and rework cycle', () => {
  let submissionId;
  before(async () => {
    const list = await api().get(`/api/professor/submissions?assignmentId=${assignmentA.id}`).set(courseProf.auth);
    submissionId = list.body.data[0].id;
  });

  it('requires feedback when requesting rework', async () => {
    const res = await api().post(`/api/professor/submissions/${submissionId}/review`).set(courseProf.auth).send({ decision: 'rework' });
    assert.equal(res.status, 422);
  });

  it('records comments, the rework decision and notifies the student', async () => {
    await api().post(`/api/professor/submissions/${submissionId}/start-review`).set(courseProf.auth).expect(200);
    await api()
      .post(`/api/professor/submissions/${submissionId}/comments`)
      .set(courseProf.auth)
      .send({ body: 'Looking at it now' })
      .expect(201);
    const res = await api()
      .post(`/api/professor/submissions/${submissionId}/review`)
      .set(courseProf.auth)
      .send({ decision: 'rework', feedback: 'Add labelled images' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.submission.status, 'rework');
    assert.equal(res.body.data.submission.reviews[0].feedback, 'Add labelled images');

    const notes = await api().get('/api/notifications').set(student.auth);
    assert.ok(notes.body.data.some((n) => n.type === 'submission_rework'));
    const twice = await api()
      .post(`/api/professor/submissions/${submissionId}/review`)
      .set(courseProf.auth)
      .send({ decision: 'completed' });
    assert.equal(twice.status, 409, 'a reviewed attempt cannot be reviewed again');
  });

  it('lets the student see the feedback and resubmit as attempt 2', async () => {
    const detail = await api().get(`/api/student/assignments/${assignmentA.id}`).set(student.auth);
    assert.equal(detail.body.data.status, 'rework');
    assert.equal(detail.body.data.canSubmit, true);
    assert.equal(detail.body.data.reviews[0].feedback, 'Add labelled images');
    assert.ok(detail.body.data.comments.some((c) => c.body === 'Looking at it now'));

    const res = await submit(student, assignmentA.id);
    assert.equal(res.status, 201);
    assert.equal(res.body.data.attempts.length, 2);
    assert.equal(res.body.data.attempts[0].attemptNo, 2);
  });

  it('marks the latest attempt completed and closes further submissions', async () => {
    const list = await api().get(`/api/professor/submissions?assignmentId=${assignmentA.id}&status=pending`).set(courseProf.auth);
    const latest = list.body.data[0];
    assert.equal(latest.attemptNo, 2);
    const res = await api()
      .post(`/api/professor/submissions/${latest.id}/review`)
      .set(courseProf.auth)
      .send({ decision: 'completed', feedback: 'Great' });
    assert.equal(res.status, 200);
    const detail = await api().get(`/api/student/assignments/${assignmentA.id}`).set(student.auth);
    assert.equal(detail.body.data.status, 'completed');
    assert.equal(detail.body.data.canSubmit, false);
  });

  it('shows the full history to admins with filters', async () => {
    const all = await api().get(`/api/admin/submissions?studentId=${student.user.id}&latestOnly=false`).set(admin.auth);
    assert.equal(all.body.meta.total, 2);
    const byProf = await api().get(`/api/admin/submissions?professorId=${moduleProf.user.id}`).set(admin.auth);
    assert.ok(byProf.body.data.every((s) => s.assignmentId === assignmentB.id));
  });

  it('refuses to delete an assignment that has submissions', async () => {
    const res = await api().delete(`/api/professor/assignments/${assignmentA.id}`).set(courseProf.auth);
    assert.equal(res.status, 409);
  });
});

describe('assignment authoring is professor-only; admins have read-only access', () => {
  const form = (req, fields) => {
    for (const [k, v] of Object.entries(fields)) req.field(k, String(v));
    return req;
  };

  it('refuses admin create, edit and delete with 403', async () => {
    const create = await form(api().post('/api/admin/assignments').set(admin.auth), { courseId: course.id, title: 'Admin task' });
    assert.equal(create.status, 403);
    const edit = await form(api().put(`/api/admin/assignments/${assignmentA.id}`).set(admin.auth), {
      courseId: course.id,
      title: 'Renamed',
    });
    assert.equal(edit.status, 403);
    assert.equal((await api().delete(`/api/admin/assignments/${assignmentB.id}`).set(admin.auth)).status, 403);
    const { rows } = await pool.query('SELECT title FROM assignments WHERE id = $1', [assignmentA.id]);
    assert.equal(rows[0].title, 'Physics report', 'nothing changed');
  });

  it('refuses admin reviews and comments (professor namespace)', async () => {
    const list = await api().get(`/api/admin/submissions?assignmentId=${assignmentB.id}`).set(admin.auth);
    const submissionId = list.body.data[0].id;
    const review = await api().post(`/api/professor/submissions/${submissionId}/review`).set(admin.auth).send({ decision: 'completed' });
    assert.equal(review.status, 403);
    const comment = await api().post(`/api/professor/submissions/${submissionId}/comments`).set(admin.auth).send({ body: 'Hi' });
    assert.equal(comment.status, 403);
  });

  it('lets admins list and view every assignment with its author', async () => {
    const list = await api().get(`/api/admin/assignments?courseId=${course.id}`).set(admin.auth);
    assert.equal(list.status, 200);
    const byId = Object.fromEntries(list.body.data.map((a) => [a.id, a]));
    assert.equal(byId[assignmentA.id].createdByName, courseProf.user.full_name);
    assert.equal(byId[assignmentB.id].createdByName, moduleProf.user.full_name);
    const detail = await api().get(`/api/admin/assignments/${assignmentB.id}`).set(admin.auth);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.attachmentKey, undefined, 'storage paths are never exposed');
  });

  it('keeps module professors inside their own module', async () => {
    const wholeCourse = await form(api().post('/api/professor/assignments').set(moduleProf.auth), {
      courseId: course.id,
      title: 'Course-wide',
    });
    assert.equal(wholeCourse.status, 422);
    assert.ok(wholeCourse.body.error.details.moduleId);
    const otherModule = await form(api().post('/api/professor/assignments').set(moduleProf.auth), {
      courseId: course.id,
      moduleId: moduleA.id,
      title: 'Not my module',
    });
    assert.equal(otherModule.status, 422);
    assert.ok(otherModule.body.error.details.moduleId);

    const modules = await api().get(`/api/professor/courses/${course.id}/modules`).set(moduleProf.auth);
    assert.deepEqual(
      modules.body.data.map((m) => m.id),
      [moduleB.id],
    );
    const all = await api().get(`/api/professor/courses/${course.id}/modules`).set(courseProf.auth);
    assert.equal(all.body.data.length, 2);
  });

  it('refuses professors outside the course', async () => {
    const create = await form(api().post('/api/professor/assignments').set(outsider.auth), { courseId: course.id, title: 'Intruder' });
    assert.equal(create.status, 422);
    assert.ok(create.body.error.details.courseId);
    assert.equal((await api().get(`/api/professor/courses/${course.id}/modules`).set(outsider.auth)).status, 404);
    const edit = await form(api().put(`/api/professor/assignments/${assignmentA.id}`).set(outsider.auth), {
      courseId: course.id,
      title: 'Hijacked',
    });
    assert.equal(edit.status, 404);
    assert.equal((await api().delete(`/api/professor/assignments/${assignmentA.id}`).set(outsider.auth)).status, 404);
    // A module professor cannot edit another module's assignment either.
    assert.equal((await api().delete(`/api/professor/assignments/${assignmentA.id}`).set(moduleProf.auth)).status, 404);
  });

  it('drafts stay hidden from students until the professor publishes (assigns) them', async () => {
    const draft = await createAssignment(courseProf.auth, { courseId: course.id, title: 'Logbook', isPublished: 'false' });
    assert.equal(draft.createdBy, courseProf.user.id);
    const mine = await api().get('/api/professor/assignments?published=false').set(courseProf.auth);
    assert.deepEqual(
      mine.body.data.map((a) => a.id),
      [draft.id],
    );
    assert.equal((await api().get(`/api/student/assignments/${draft.id}`).set(student.auth)).status, 404);

    const publish = await form(api().put(`/api/professor/assignments/${draft.id}`).set(courseProf.auth), {
      courseId: course.id,
      title: 'Logbook',
      isPublished: 'true',
    });
    assert.equal(publish.status, 200);
    assert.equal((await api().get(`/api/student/assignments/${draft.id}`).set(student.auth)).status, 200);
    const notes = await api().get('/api/notifications').set(student.auth);
    assert.ok(notes.body.data.some((n) => n.type === 'assignment_published' && n.link === `/student/assignments/${draft.id}`));

    assert.equal((await api().delete(`/api/professor/assignments/${draft.id}`).set(courseProf.auth)).status, 200);
    const { rows } = await pool.query(`SELECT 1 FROM activity_logs WHERE action = 'assignment.deleted' AND actor_id = $1`, [
      courseProf.user.id,
    ]);
    assert.equal(rows.length, 1);
  });
});

describe('submission status transitions', () => {
  const setStatus = (id, status) => pool.query('UPDATE assignment_submissions SET status = $2 WHERE id = $1', [id, status]);

  it('rejects any change the lifecycle does not allow, at the database level', async () => {
    const { rows } = await pool.query(
      `SELECT id, status FROM assignment_submissions WHERE assignment_id = $1 AND student_id = $2 ORDER BY attempt_no`,
      [assignmentA.id, student.user.id],
    );
    const [rework, completed] = rows;
    assert.equal(rework.status, 'rework');
    assert.equal(completed.status, 'completed');
    for (const target of ['submitted', 'in_review', 'rework']) {
      await assert.rejects(setStatus(completed.id, target), /cannot change from completed/);
    }
    for (const target of ['submitted', 'in_review', 'completed']) {
      await assert.rejects(setStatus(rework.id, target), /cannot change from rework/);
    }
  });

  it('allows submitted → in_review → completed/rework, and never back to submitted', async () => {
    const list = await api().get(`/api/professor/submissions?assignmentId=${assignmentB.id}`).set(moduleProf.auth);
    const { id } = list.body.data[0];
    await api().post(`/api/professor/submissions/${id}/start-review`).set(moduleProf.auth).expect(200);
    await assert.rejects(setStatus(id, 'submitted'), /cannot change from in_review to submitted/);
    const res = await api()
      .post(`/api/professor/submissions/${id}/review`)
      .set(moduleProf.auth)
      .send({ decision: 'rework', feedback: 'Redo' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.submission.status, 'rework');
  });
});
