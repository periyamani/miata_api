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
  mp4Bytes,
  pdfBytes,
  resetDatabase,
  userWithToken,
} from './helpers.js';

// End-to-end batch workflow: admin creates batches → assigns courses and professors → adds students → sets material
// availability → professors assign batch work → students submit → professors review → admin tracks progress.

let admin, profA, profB, courseProf, s1, s2, s3, s4, course, moduleX, moduleY, batchA, batchB;
let wholeBatchWork, selectedWork, courseWideWork;

const submit = (who, assignmentId) =>
  api()
    .post(`/api/student/assignments/${assignmentId}/submissions`)
    .set(who.auth)
    .attach('file', pdfBytes(), { filename: 'work.pdf', contentType: 'application/pdf' });
const ids = (rows) => rows.map((r) => r.id).sort((a, b) => a - b);
const names = (rows) => rows.map((r) => r.fullName ?? r.studentName).sort();
const progressOf = async (who) =>
  (await api().get('/api/student/courses').set(who.auth)).body.data.find((c) => c.courseId === course.id).progress;

before(async () => {
  await resetDatabase();
  admin = await userWithToken('admin');
  profA = await userWithToken('professor', { fullName: 'Prof A' });
  profB = await userWithToken('professor', { fullName: 'Prof B' });
  courseProf = await userWithToken('professor', { fullName: 'Course Prof' });
  s1 = await userWithToken('student', { fullName: 'Student One' });
  s2 = await userWithToken('student', { fullName: 'Student Two' });
  s3 = await userWithToken('student', { fullName: 'Student Three' });
  s4 = await userWithToken('student', { fullName: 'Student Four' });

  course = await createCourse(admin.auth, { title: 'PG Diploma' });
  moduleX = await createModule(admin.auth, course.id, 'Physics');
  moduleY = await createModule(admin.auth, course.id, 'Obstetrics');
  await assignProfessor(admin.auth, course.id, courseProf.user.id);
});
after(closeDatabase);

describe('admin batch management', () => {
  it('creates batches with their courses and professors', async () => {
    const a = await api()
      .post('/api/admin/batches')
      .set(admin.auth)
      .send({ code: 'pg-2026a', name: 'Batch 2026-A', startDate: '2026-05-01', courseIds: [course.id], professorIds: [profA.user.id] });
    assert.equal(a.status, 201);
    assert.equal(a.body.data.code, 'PG-2026A', 'codes are upper-cased');
    assert.deepEqual(
      a.body.data.courses.map((c) => c.id),
      [course.id],
    );
    assert.deepEqual(
      a.body.data.professors.map((p) => p.id),
      [profA.user.id],
    );
    batchA = a.body.data;

    const b = await api()
      .post('/api/admin/batches')
      .set(admin.auth)
      .send({ code: 'PG-2026B', name: 'Batch 2026-B', courseIds: [course.id] });
    assert.equal(b.status, 201);
    batchB = b.body.data;
    const assign = await api().post(`/api/admin/batches/${batchB.id}/professors`).set(admin.auth).send({ professorId: profB.user.id });
    assert.equal(assign.status, 201);
  });

  it('rejects duplicate codes and end dates before start dates', async () => {
    const dup = await api().post('/api/admin/batches').set(admin.auth).send({ code: 'PG-2026A', name: 'Again' });
    assert.equal(dup.status, 409);
    const dates = await api()
      .post('/api/admin/batches')
      .set(admin.auth)
      .send({ code: 'PG-X', name: 'Bad dates', startDate: '2026-05-01', endDate: '2026-04-01' });
    assert.equal(dates.status, 422);
    assert.ok(dates.body.error.details.endDate);
  });

  it('adds students to a batch and enrols them in its courses', async () => {
    const res = await api()
      .post(`/api/admin/batches/${batchA.id}/students`)
      .set(admin.auth)
      .send({ studentIds: [s1.user.id, s2.user.id] });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.added, 2);
    assert.equal(res.body.data.enrolled, 2);
    await api()
      .post(`/api/admin/batches/${batchB.id}/students`)
      .set(admin.auth)
      .send({ studentIds: [s3.user.id] });
    await enrol(admin.auth, course.id, [s4.user.id]); // s4 takes the course without a batch

    const enrolled = await api().get(`/api/admin/courses/${course.id}/students`).set(admin.auth);
    assert.equal(enrolled.body.meta.total, 4);
    const unbatched = await api().get('/api/admin/students').query({ batchId: 'none' }).set(admin.auth);
    assert.deepEqual(names(unbatched.body.data), ['Student Four']);
  });

  it('keeps a student in one batch: adding to another batch moves them', async () => {
    const moved = await api().put(`/api/admin/students/${s2.user.id}/batch`).set(admin.auth).send({ batchId: batchB.id });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.data.batch.id, batchB.id);
    const back = await api()
      .post(`/api/admin/batches/${batchA.id}/students`)
      .set(admin.auth)
      .send({ studentIds: [s2.user.id] });
    assert.equal(back.body.data.moved, 1);
    const { rows } = await pool.query('SELECT batch_id FROM batch_students WHERE student_id = $1', [s2.user.id]);
    assert.deepEqual(
      rows.map((r) => Number(r.batch_id)),
      [batchA.id],
    );
  });

  it('only deletes empty batches', async () => {
    assert.equal((await api().delete(`/api/admin/batches/${batchA.id}`).set(admin.auth)).status, 409);
    const empty = await api().post('/api/admin/batches').set(admin.auth).send({ code: 'EMPTY-1', name: 'Empty' });
    assert.equal((await api().delete(`/api/admin/batches/${empty.body.data.id}`).set(admin.auth)).status, 200);
  });
});

describe('professor scope', () => {
  it('shows each batch professor only their own batch', async () => {
    const a = await api().get('/api/professor/students').set(profA.auth);
    assert.deepEqual(names(a.body.data), ['Student One', 'Student Two']);
    assert.ok(a.body.data.every((r) => r.batchName === 'Batch 2026-A'));
    const b = await api().get('/api/professor/students').set(profB.auth);
    assert.deepEqual(names(b.body.data), ['Student Three']);
    const batches = await api().get('/api/professor/batches').set(profA.auth);
    assert.deepEqual(
      batches.body.data.map((x) => x.id),
      [batchA.id],
    );
  });

  it('leaves batched students to their batch professors (course professors keep the unbatched ones)', async () => {
    const res = await api().get('/api/professor/students').set(courseProf.auth);
    assert.deepEqual(names(res.body.data), ['Student Four']);
  });
});

describe('batch-wise assignments', () => {
  it('assigns work to a whole batch', async () => {
    wholeBatchWork = await createAssignment(profA.auth, {
      courseId: course.id,
      moduleId: moduleX.id,
      batchId: batchA.id,
      title: 'Batch A logbook',
    });
    assert.equal(wholeBatchWork.batchId, batchA.id);
    assert.equal(wholeBatchWork.studentCount, 2);
    for (const who of [s1, s2]) assert.equal((await api().get(`/api/student/assignments/${wholeBatchWork.id}`).set(who.auth)).status, 200);
    for (const who of [s3, s4]) assert.equal((await api().get(`/api/student/assignments/${wholeBatchWork.id}`).set(who.auth)).status, 404);
  });

  it('assigns work to selected students of a batch', async () => {
    selectedWork = await createAssignment(profA.auth, {
      courseId: course.id,
      batchId: batchA.id,
      studentIds: String(s1.user.id),
      title: 'Case presentation',
    });
    assert.equal(selectedWork.recipientCount, 1);
    assert.equal((await api().get(`/api/student/assignments/${selectedWork.id}`).set(s1.auth)).status, 200);
    assert.equal((await api().get(`/api/student/assignments/${selectedWork.id}`).set(s2.auth)).status, 404);
  });

  it('notifies exactly the students the work is assigned to', async () => {
    const { rows } = await pool.query(`SELECT user_id FROM notifications WHERE type = 'assignment_published' AND link = $1`, [
      `/student/assignments/${selectedWork.id}`,
    ]);
    assert.deepEqual(
      rows.map((r) => Number(r.user_id)),
      [s1.user.id],
    );
  });

  it('refuses placements outside the professor’s batches', async () => {
    const post = (who, fields) => {
      const req = api().post('/api/professor/assignments').set(who.auth);
      for (const [k, v] of Object.entries({ title: 'X', courseId: course.id, ...fields })) req.field(k, String(v));
      return req;
    };
    const otherBatch = await post(profB, { batchId: batchA.id });
    assert.equal(otherBatch.status, 422);
    assert.ok(otherBatch.body.error.details.batchId);
    const courseWide = await post(profA, {});
    assert.equal(courseWide.status, 422);
    assert.ok(courseWide.body.error.details.batchId, 'a batch professor must choose their batch');
    const outsider = await post(profA, { batchId: batchA.id, studentIds: s3.user.id });
    assert.equal(outsider.status, 422);
    assert.ok(outsider.body.error.details.studentIds);
  });

  it('gives course-wide work to every student, reviewed by each student’s own professors', async () => {
    courseWideWork = await createAssignment(courseProf.auth, { courseId: course.id, title: 'Course-wide report' });
    for (const who of [s1, s2, s3, s4])
      assert.equal((await api().get(`/api/student/assignments/${courseWideWork.id}`).set(who.auth)).status, 200);
    assert.equal(courseWideWork.studentCount, 1, 'the course professor counts only the students they teach');

    const sub = await submit(s1, courseWideWork.id);
    assert.equal(sub.status, 201);
    const submissionId = sub.body.data.latestSubmissionId;
    assert.equal((await api().get(`/api/professor/submissions/${submissionId}`).set(courseProf.auth)).status, 404);
    assert.equal((await api().get(`/api/professor/submissions/${submissionId}`).set(profB.auth)).status, 404);
    const review = await api()
      .post(`/api/professor/submissions/${submissionId}/review`)
      .set(profA.auth)
      .send({ decision: 'rework', feedback: 'Add the measurements.' });
    assert.equal(review.status, 200);
    assert.equal(review.body.data.submission.status, 'rework');

    const { rows } = await pool.query(`SELECT user_id FROM notifications WHERE type = 'submission_received'`);
    assert.deepEqual(
      rows.map((r) => Number(r.user_id)),
      [profA.user.id],
      'only the batch professor is told about the submission',
    );
  });

  it('lets batch professors see but not change course-wide work', async () => {
    const seen = await api().get(`/api/professor/assignments/${courseWideWork.id}`).set(profA.auth);
    assert.equal(seen.status, 200);
    assert.equal(seen.body.data.canManage, false);
    const edit = await api()
      .put(`/api/professor/assignments/${courseWideWork.id}`)
      .set(profA.auth)
      .field('courseId', String(course.id))
      .field('title', 'Changed');
    assert.equal(edit.status, 403);
  });

  it('runs the full submit → review cycle on batch work', async () => {
    const sub = await submit(s2, wholeBatchWork.id);
    assert.equal(sub.status, 201);
    const id = sub.body.data.latestSubmissionId;
    assert.equal((await api().post(`/api/professor/submissions/${id}/start-review`).set(profA.auth)).status, 200);
    await api().post(`/api/professor/submissions/${id}/comments`).set(profA.auth).send({ body: 'Looks good.' });
    const done = await api().post(`/api/professor/submissions/${id}/review`).set(profA.auth).send({ decision: 'completed' });
    assert.equal(done.body.data.submission.status, 'completed');
    const seen = await api().get(`/api/student/assignments/${wholeBatchWork.id}`).set(s2.auth);
    assert.equal(seen.body.data.status, 'completed');
    assert.equal(seen.body.data.comments[0].body, 'Looks good.');
    assert.equal(seen.body.data.batchName, 'Batch 2026-A');
  });

  it('counts only a student’s own work towards progress', async () => {
    assert.equal((await progressOf(s1)).assignmentsTotal, 3, 'batch work + selected work + course-wide');
    assert.equal((await progressOf(s2)).assignmentsTotal, 2, 'not selected for the presentation');
    assert.equal((await progressOf(s3)).assignmentsTotal, 1, 'another batch: course-wide only');
    assert.equal((await progressOf(s4)).assignmentsTotal, 1, 'unbatched: course-wide only');
  });
});

describe('learning material availability', () => {
  it('restricts a module (and its lessons and work) to chosen batches', async () => {
    const bad = await api()
      .put(`/api/admin/modules/${moduleY.id}/batches`)
      .set(admin.auth)
      .send({ batchIds: [999999] });
    assert.equal(bad.status, 422);
    const res = await api()
      .put(`/api/admin/modules/${moduleY.id}/batches`)
      .set(admin.auth)
      .send({ batchIds: [batchB.id] });
    assert.equal(res.status, 200);
    const modulesOf = async (who) =>
      (await api().get(`/api/student/courses/${course.id}`).set(who.auth)).body.data.modules.map((m) => m.id);
    assert.deepEqual(await modulesOf(s1), [moduleX.id]);
    assert.deepEqual(await modulesOf(s3), [moduleX.id, moduleY.id]);
    assert.deepEqual(await modulesOf(s4), [moduleX.id], 'restricted material is not shown to unbatched students');
    const materials = await api().get(`/api/admin/batches/${batchA.id}/materials`).set(admin.auth);
    assert.equal(materials.body.data.modules.find((m) => m.id === moduleY.id).available, false);
  });

  it('restricts a video to chosen batches', async () => {
    const upload = await api()
      .post('/api/admin/videos')
      .set(admin.auth)
      .field('courseId', String(course.id))
      .field('title', 'Batch A live session')
      .field('durationSeconds', '1')
      .field('isPublished', 'true')
      .field('batchIds', String(batchA.id))
      .attach('video', mp4Bytes(60), { filename: 'session.mp4', contentType: 'video/mp4' });
    assert.equal(upload.status, 201);
    assert.deepEqual(
      upload.body.data.batches.map((b) => b.id),
      [batchA.id],
    );
    const video = upload.body.data;
    const ok = await api().get(`/api/student/videos/${video.id}`).set(s1.auth);
    assert.equal(ok.status, 200);
    assert.equal((await api().get(`/api/student/videos/${video.id}`).set(s3.auth)).status, 404);
    const listed = await api().get('/api/student/videos').set(s3.auth);
    assert.ok(!listed.body.data.some((v) => v.id === video.id));
    assert.equal((await progressOf(s3)).videosTotal, 0, 'another batch’s video never blocks completion');
  });
});

describe('admin tracking', () => {
  it('reports batch-wise students, assignments and submissions', async () => {
    const students = await api().get(`/api/admin/batches/${batchA.id}/students`).set(admin.auth);
    const one = students.body.data.find((s) => s.id === s1.user.id);
    assert.equal(one.assignmentsTotal, 3);
    assert.equal(one.assignmentsRework, 1);
    assert.equal(one.courses.length, 1);

    const work = await api().get('/api/admin/assignments').query({ batchId: batchA.id }).set(admin.auth);
    assert.deepEqual(ids(work.body.data), ids([wholeBatchWork, selectedWork, courseWideWork]));
    const courseWide = work.body.data.find((a) => a.id === courseWideWork.id);
    assert.equal(courseWide.studentCount, 2, 'counts are limited to the batch’s students');

    const subs = await api().get('/api/admin/submissions').query({ batchId: batchA.id }).set(admin.auth);
    assert.equal(subs.body.meta.total, 2);
    assert.ok(subs.body.data.every((s) => s.batchName === 'Batch 2026-A'));

    const detail = await api().get(`/api/admin/batches/${batchA.id}`).set(admin.auth);
    assert.equal(detail.body.data.studentCount, 2);
    assert.ok(detail.body.data.progress.averagePercent > 0);
  });

  it('closes an inactive batch to new students and new batch work', async () => {
    assert.equal((await api().patch(`/api/admin/batches/${batchB.id}/status`).set(admin.auth).send({ isActive: false })).status, 200);
    const add = await api()
      .post(`/api/admin/batches/${batchB.id}/students`)
      .set(admin.auth)
      .send({ studentIds: [s4.user.id] });
    assert.equal(add.status, 422);
    const req = api().post('/api/professor/assignments').set(profB.auth);
    for (const [k, v] of Object.entries({ title: 'Late', courseId: course.id, batchId: batchB.id })) req.field(k, String(v));
    assert.equal((await req).status, 422);
  });
});
