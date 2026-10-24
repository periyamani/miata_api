import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/config/db.js';
import { api, assignProfessor, closeDatabase, createCourse, createModule, resetDatabase, userWithToken } from './helpers.js';

// Module status (migration 017): the professors who teach a module — its course's professors, or its own — mark it
// Not Started, In Progress or Completed from their dashboard; admins see it on the course's curriculum.

let admin, courseProf, moduleProf, batchProf, outsider, course, physics, obstetrics;

const modulesOf = async (who) => (await api().get('/api/professor/modules').set(who.auth)).body.data;
const setStatus = (who, moduleId, status) => api().put(`/api/professor/modules/${moduleId}/status`).set(who.auth).send({ status });
const curriculumOf = async (courseId) => (await api().get(`/api/admin/courses/${courseId}`).set(admin.auth)).body.data.modules;
const STATUS_ACTIONS = ['module.not_started', 'module.in_progress', 'module.completed'];
const logsFor = async (moduleId) =>
  (
    await pool.query(
      `SELECT action, actor_id, metadata FROM activity_logs
        WHERE entity_type = 'module' AND entity_id = $1 AND action = ANY($2) ORDER BY id`,
      [moduleId, STATUS_ACTIONS],
    )
  ).rows;

before(async () => {
  await resetDatabase();
  admin = await userWithToken('admin');
  courseProf = await userWithToken('professor', { fullName: 'Course Prof' });
  moduleProf = await userWithToken('professor', { fullName: 'Module Prof' });
  batchProf = await userWithToken('professor', { fullName: 'Batch Prof' });
  outsider = await userWithToken('professor', { fullName: 'Other Prof' });

  course = await createCourse(admin.auth, { title: 'PG Diploma' });
  physics = await createModule(admin.auth, course.id, 'Physics');
  obstetrics = await createModule(admin.auth, course.id, 'Obstetrics');
  await api().post(`/api/admin/modules/${physics.id}/lessons`).set(admin.auth).send({ title: 'Sound waves' });
  await assignProfessor(admin.auth, course.id, courseProf.user.id);
  await api().post(`/api/admin/modules/${physics.id}/professors`).set(admin.auth).send({ professorId: moduleProf.user.id });
  const batch = await api()
    .post('/api/admin/batches')
    .set(admin.auth)
    .send({ code: 'PG-A', name: 'Batch A', courseIds: [course.id], professorIds: [batchProf.user.id] });
  assert.equal(batch.status, 201);
});
after(closeDatabase);

describe('database', () => {
  it('allows one status row per module, with dates that match the status', async () => {
    await assert.rejects(pool.query(`INSERT INTO module_statuses (module_id, status) VALUES ($1, 'paused')`, [obstetrics.id]));
    await assert.rejects(pool.query(`INSERT INTO module_statuses (module_id, status) VALUES ($1, 'completed')`, [obstetrics.id]));
    await assert.rejects(
      pool.query(`INSERT INTO module_statuses (module_id, status, started_at) VALUES ($1, 'not_started', now())`, [obstetrics.id]),
    );
  });
});

describe('professor modules', () => {
  it('lists every module of a course the professor teaches as a whole, and only their own module for a module professor', async () => {
    const all = await modulesOf(courseProf);
    assert.deepEqual(
      all.map((m) => m.title),
      ['Physics', 'Obstetrics'],
    );
    assert.ok(all.every((m) => m.teachingStatus === 'not_started' && m.teachingStartedAt === null && m.teachingCompletedAt === null));
    const own = await modulesOf(moduleProf);
    assert.equal(own.length, 1);
    assert.equal(own[0].id, physics.id);
    assert.equal(own[0].courseTitle, 'PG Diploma');
    assert.deepEqual(
      all.map((m) => m.number),
      [1, 2],
    );
    assert.equal(own[0].lessonCount, 1);
    assert.deepEqual(own[0].professors, ['Module Prof']);
  });

  it('leaves batch-only and unrelated professors without modules to update', async () => {
    assert.deepEqual(await modulesOf(batchProf), []);
    assert.deepEqual(await modulesOf(outsider), []);
    assert.equal((await setStatus(batchProf, physics.id, 'in_progress')).status, 404);
    assert.equal((await setStatus(outsider, physics.id, 'in_progress')).status, 404);
    assert.equal((await setStatus(moduleProf, obstetrics.id, 'in_progress')).status, 404, 'not their module');
  });

  it('rejects unknown statuses', async () => {
    const res = await setStatus(moduleProf, physics.id, 'paused');
    assert.equal(res.status, 422);
    assert.ok(res.body.error.details.status);
  });

  it('starts, completes and resets a module, keeping the first start', async () => {
    const started = await setStatus(moduleProf, physics.id, 'in_progress');
    assert.equal(started.status, 200);
    assert.equal(started.body.data.teachingStatus, 'in_progress');
    assert.equal(started.body.data.teachingUpdatedBy, 'Module Prof');
    const startedAt = started.body.data.teachingStartedAt;
    assert.ok(startedAt);
    assert.equal(started.body.data.teachingCompletedAt, null);

    const completed = await setStatus(courseProf, physics.id, 'completed');
    assert.equal(completed.body.data.teachingStatus, 'completed');
    assert.equal(completed.body.data.teachingStartedAt, startedAt, 'the start is kept');
    assert.ok(completed.body.data.teachingCompletedAt);
    assert.equal(completed.body.data.teachingUpdatedBy, 'Course Prof');

    const reopened = await setStatus(moduleProf, physics.id, 'in_progress');
    assert.equal(reopened.body.data.teachingStartedAt, startedAt);
    assert.equal(reopened.body.data.teachingCompletedAt, null);

    const reset = await setStatus(moduleProf, physics.id, 'not_started');
    assert.equal(reset.body.data.teachingStatus, 'not_started');
    assert.equal(reset.body.data.teachingStartedAt, null);
  });

  it('logs each change, and nothing when the status does not change', async () => {
    await setStatus(moduleProf, physics.id, 'not_started'); // already not started
    const logs = await logsFor(physics.id);
    assert.deepEqual(
      logs.map((l) => l.action),
      ['module.in_progress', 'module.completed', 'module.in_progress', 'module.not_started'],
    );
    assert.deepEqual(logs[1].metadata, { courseId: course.id, from: 'in_progress', to: 'completed' });
    assert.equal(logs[1].actor_id, courseProf.user.id);
  });

  it('shows the status on the admin curriculum', async () => {
    await setStatus(courseProf, obstetrics.id, 'in_progress');
    const modules = await curriculumOf(course.id);
    const ob = modules.find((m) => m.id === obstetrics.id);
    assert.equal(ob.teachingStatus, 'in_progress');
    assert.equal(ob.teachingUpdatedBy, 'Course Prof');
    assert.ok(ob.teachingStartedAt);
    assert.equal(modules.find((m) => m.id === physics.id).teachingStatus, 'not_started');
  });

  it('hides the modules of inactive courses', async () => {
    await pool.query('UPDATE courses SET is_active = FALSE WHERE id = $1', [course.id]);
    assert.deepEqual(await modulesOf(courseProf), []);
    assert.equal((await setStatus(courseProf, physics.id, 'in_progress')).status, 404);
    await pool.query('UPDATE courses SET is_active = TRUE WHERE id = $1', [course.id]);
  });

  it('drops the status with its module', async () => {
    const extra = await createModule(admin.auth, course.id, 'Vascular');
    await setStatus(courseProf, extra.id, 'completed');
    assert.equal((await api().delete(`/api/admin/modules/${extra.id}`).set(admin.auth)).status, 200);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM module_statuses WHERE module_id = $1', [extra.id]);
    assert.equal(rows[0].n, 0);
  });
});
