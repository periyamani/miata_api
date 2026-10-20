import { withTransaction } from '../../../config/db.js';
import { AppError, conflict, notFound } from '../../../utils/AppError.js';
import { logActivity } from '../../../services/activity.service.js';
import { notifyUsers } from '../../../services/notification.service.js';
import { attachProgress, progressByGroup } from '../../../services/progress.service.js';
import { getCompletionPolicy } from '../../../services/settings.service.js';
import { batchEnrolments, batchesOutsideCourse, replaceAvailability } from '../../../repositories/batches.repository.js';
import { enrolWithin } from '../enrolments/enrolments.service.js';
import * as repo from './batches.repository.js';

// A batch is a cohort: its students take its courses together, taught by its professors. Course access stays with
// course_enrolments, so adding students or courses to a batch enrols the students (existing enrolments are kept).

const invalid = (field, message) => new AppError(422, 'VALIDATION_ERROR', message, { [field]: message });
const codeConflict = () => conflict('A batch with this code already exists', { code: 'This batch code is already in use' });
const NO_PROGRESS = { enrolments: 0, completed: 0, average_percent: 0 };

async function withProgress(rows) {
  const [enrolments, policy] = await Promise.all([batchEnrolments(rows.map((b) => b.id)), getCompletionPolicy()]);
  const progress = progressByGroup(enrolments, policy, 'batch_id');
  return rows.map((b) => ({ ...b, progress: progress[b.id] ?? NO_PROGRESS }));
}

async function requireBatch(id, db, options) {
  const batch = await repo.findBatch(id, db, options);
  if (!batch) throw notFound('Batch');
  return batch;
}

export async function listBatches(query) {
  const result = await repo.listBatches(query);
  return { ...result, rows: await withProgress(result.rows) };
}

export async function getBatch(id) {
  const batch = await requireBatch(id);
  const [[withSummary], courses, professors] = await Promise.all([withProgress([batch]), repo.batchCourses(id), repo.batchProfessors(id)]);
  return { ...withSummary, courses, professors };
}

/** Students with their assignment tracking and progress in each of the batch's courses. */
export async function listBatchStudents(id, query) {
  await requireBatch(id);
  const [result, enrolments, policy] = await Promise.all([repo.batchStudents(id, query), batchEnrolments([id]), getCompletionPolicy()]);
  const progress = attachProgress(enrolments, policy);
  return {
    ...result,
    rows: result.rows.map((s) => {
      const courses = progress
        .filter((e) => e.student_id === s.id)
        .map((e) => ({ course_id: e.course_id, status: e.status, progress: e.progress }));
      const average = courses.length ? Math.round(courses.reduce((sum, c) => sum + c.progress.percent, 0) / courses.length) : 0;
      return { ...s, courses, average_percent: average };
    }),
  };
}

export const materials = (id) => requireBatch(id).then(() => repo.batchMaterials(id));

// ─── Batch records ──────────────────────────────────────────────────────

export async function createBatch(data, actor) {
  const created = await withTransaction(async (db) => {
    if (await repo.codeTaken(data.code, null, db)) throw codeConflict();
    const batch = await repo.insertBatch(data, actor.id, db);
    await logActivity(
      { actorId: actor.id, action: 'batch.created', entityType: 'batch', entityId: batch.id, description: `Batch "${batch.name}" created` },
      db,
    );
    for (const courseId of data.courseIds) await addCourseWithin(db, batch, courseId, actor, 'courseIds');
    for (const professorId of data.professorIds) await assignProfessorWithin(db, batch, professorId, actor, 'professorIds');
    return batch;
  });
  return getBatch(created.id);
}

export async function updateBatch(id, data, actor) {
  await withTransaction(async (db) => {
    if (await repo.codeTaken(data.code, id, db)) throw codeConflict();
    const batch = await repo.updateBatch(id, data, db);
    if (!batch) throw notFound('Batch');
    await logActivity(
      { actorId: actor.id, action: 'batch.updated', entityType: 'batch', entityId: id, description: `Batch "${batch.name}" updated` },
      db,
    );
  });
  return getBatch(id);
}

/** Inactive batches keep their students and history; they take no new students, courses or batch assignments. */
export async function setBatchStatus(id, isActive, actor) {
  await withTransaction(async (db) => {
    const batch = await repo.setBatchActive(id, isActive, db);
    if (!batch) throw notFound('Batch');
    await logActivity(
      {
        actorId: actor.id,
        action: isActive ? 'batch.activated' : 'batch.deactivated',
        entityType: 'batch',
        entityId: id,
        description: `Batch "${batch.name}" ${isActive ? 'activated' : 'deactivated'}`,
      },
      db,
    );
  });
  return getBatch(id);
}

/** Only an empty batch can be deleted; anything with students, assignments or material restrictions is deactivated instead. */
export async function deleteBatch(id, actor) {
  await withTransaction(async (db) => {
    const batch = await requireBatch(id, db, { lock: true });
    const refs = await repo.batchReferences(id, db);
    if (refs.students) throw conflict('Remove the students from this batch first, or deactivate it instead.');
    if (refs.assignments) throw conflict('This batch has assignments, which are part of student records. Deactivate it instead.');
    if (refs.materials) throw conflict('Some modules or videos are restricted to this batch. Change their availability first.');
    await repo.deleteBatch(id, db);
    await logActivity(
      { actorId: actor.id, action: 'batch.deleted', entityType: 'batch', entityId: id, description: `Batch "${batch.name}" deleted` },
      db,
    );
  });
}

// ─── Students ───────────────────────────────────────────────────────────

/**
 * Add students to the batch, moving them from their current batch if they have one (a student belongs to one
 * batch), and enrol them in the batch's active courses.
 */
export const addStudents = (batchId, studentIds, actor) => withTransaction((db) => addStudentsWithin(db, batchId, studentIds, actor));

/** Same as `addStudents`, inside the caller's transaction (e.g. while creating the student account). */
export async function addStudentsWithin(db, batchId, studentIds, actor) {
  const batch = await requireBatch(batchId, db, { lock: true });
  if (!batch.is_active) throw invalid('batchId', `"${batch.name}" is inactive. Activate it before adding students.`);
  const { rows: students } = await db.query(
    `SELECT u.id, u.full_name, bs.batch_id AS current_batch_id, cb.name AS current_batch_name
       FROM users u LEFT JOIN batch_students bs ON bs.student_id = u.id LEFT JOIN batches cb ON cb.id = bs.batch_id
      WHERE u.id = ANY($1::bigint[]) AND u.role = 'student' FOR UPDATE OF u`,
    [studentIds],
  );
  if (students.length !== new Set(studentIds).size) throw invalid('studentIds', 'One or more selected users are not students');

  const changed = students.filter((s) => s.current_batch_id !== batch.id);
  for (const s of changed) {
    if (s.current_batch_id) {
      await db.query('UPDATE batch_students SET batch_id = $2, added_by = $3, added_at = now() WHERE student_id = $1', [
        s.id,
        batch.id,
        actor.id,
      ]);
    } else {
      await db.query('INSERT INTO batch_students (batch_id, student_id, added_by) VALUES ($1, $2, $3)', [batch.id, s.id, actor.id]);
    }
    await logActivity(
      {
        actorId: actor.id,
        action: s.current_batch_id ? 'batch.student_moved' : 'batch.student_added',
        entityType: 'batch',
        entityId: batch.id,
        description: s.current_batch_id
          ? `${s.full_name} moved from ${s.current_batch_name} to ${batch.name}`
          : `${s.full_name} added to ${batch.name}`,
        metadata: { studentId: s.id, previousBatchId: s.current_batch_id },
      },
      db,
    );
  }
  await notifyUsers(
    changed.map((s) => s.id),
    {
      type: 'batch_joined',
      title: `You have joined ${batch.name}`,
      body: 'Your courses and learning materials follow your batch.',
      link: '/student',
    },
    db,
  );

  const courseIds = await repo.activeCourseIds(batch.id, db);
  const enrolled =
    changed.length && courseIds.length
      ? await enrolWithin(db, { courseIds, studentIds: changed.map((s) => s.id) }, actor)
      : { enrolled: 0 };
  return {
    added: changed.filter((s) => !s.current_batch_id).length,
    moved: changed.filter((s) => s.current_batch_id).length,
    alreadyInBatch: students.length - changed.length,
    enrolled: enrolled.enrolled,
  };
}

/** The student leaves the batch; their enrolments, submissions and progress are kept. */
export const removeStudent = (batchId, studentId, actor) => withTransaction((db) => removeStudentWithin(db, batchId, studentId, actor));

export async function removeStudentWithin(db, batchId, studentId, actor) {
  const { rows } = await db.query(
    `DELETE FROM batch_students bs USING users u, batches b
      WHERE bs.batch_id = $1 AND bs.student_id = $2 AND u.id = bs.student_id AND b.id = bs.batch_id
      RETURNING u.full_name, b.name AS batch_name`,
    [batchId, studentId],
  );
  if (!rows[0]) throw notFound('Student in this batch');
  await logActivity(
    {
      actorId: actor.id,
      action: 'batch.student_removed',
      entityType: 'batch',
      entityId: batchId,
      description: `${rows[0].full_name} removed from ${rows[0].batch_name}`,
      metadata: { studentId },
    },
    db,
  );
}

// ─── Courses & professors ───────────────────────────────────────────────

export const addCourse = (batchId, courseId, actor) =>
  withTransaction(async (db) => addCourseWithin(db, await requireBatch(batchId, db, { lock: true }), courseId, actor));

/** Attach a course to the batch and enrol every student of the batch in it. */
async function addCourseWithin(db, batch, courseId, actor, field = 'courseId') {
  const { rows } = await db.query('SELECT id, title, is_active FROM courses WHERE id = $1', [courseId]);
  const course = rows[0];
  if (!course) throw invalid(field, 'Select a valid course');
  if (!course.is_active) throw invalid(field, `"${course.title}" is inactive. Activate it before adding it to a batch.`);
  const { rowCount } = await db.query(
    `INSERT INTO batch_courses (batch_id, course_id, added_by) VALUES ($1, $2, $3) ON CONFLICT (batch_id, course_id) DO NOTHING`,
    [batch.id, courseId, actor.id],
  );
  if (!rowCount) return { added: false, enrolled: 0 };
  const studentIds = await repo.batchStudentIds(batch.id, db);
  const { enrolled } = studentIds.length ? await enrolWithin(db, { courseIds: [courseId], studentIds }, actor) : { enrolled: 0 };
  await logActivity(
    {
      actorId: actor.id,
      action: 'batch.course_added',
      entityType: 'batch',
      entityId: batch.id,
      description: `${course.title} added to ${batch.name}`,
      metadata: { courseId, enrolled },
    },
    db,
  );
  return { added: true, enrolled };
}

/** Students keep their enrolment in the course; it is simply no longer taken with the batch. */
export async function removeCourse(batchId, courseId, actor) {
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `DELETE FROM batch_courses bc USING courses c, batches b
        WHERE bc.batch_id = $1 AND bc.course_id = $2 AND c.id = bc.course_id AND b.id = bc.batch_id
        RETURNING c.title, b.name`,
      [batchId, courseId],
    );
    if (!rows[0]) throw notFound('Course in this batch');
    await logActivity(
      {
        actorId: actor.id,
        action: 'batch.course_removed',
        entityType: 'batch',
        entityId: batchId,
        description: `${rows[0].title} removed from ${rows[0].name}`,
        metadata: { courseId },
      },
      db,
    );
  });
}

export const assignProfessor = (batchId, professorId, actor) =>
  withTransaction(async (db) => assignProfessorWithin(db, await requireBatch(batchId, db, { lock: true }), professorId, actor));

/** A batch professor teaches every course of the batch, to the batch's students only. */
async function assignProfessorWithin(db, batch, professorId, actor, field = 'professorId') {
  const { rows } = await db.query(`SELECT id, full_name, is_active FROM users WHERE id = $1 AND role = 'professor'`, [professorId]);
  const professor = rows[0];
  if (!professor) throw invalid(field, 'This user is not a professor');
  if (!professor.is_active) throw invalid(field, 'This professor account is deactivated');
  const { rowCount } = await db.query(
    `INSERT INTO batch_professors (batch_id, professor_id, assigned_by) VALUES ($1, $2, $3) ON CONFLICT (batch_id, professor_id) DO NOTHING`,
    [batch.id, professorId, actor.id],
  );
  if (rowCount) {
    await notifyUsers(
      [professorId],
      { type: 'batch_assigned', title: `You have been assigned to ${batch.name}`, link: `/professor/students?batchId=${batch.id}` },
      db,
    );
    await logActivity(
      {
        actorId: actor.id,
        action: 'batch.professor_assigned',
        entityType: 'batch',
        entityId: batch.id,
        description: `${professor.full_name} assigned to ${batch.name}`,
        metadata: { professorId },
      },
      db,
    );
  }
  return { assigned: true, alreadyAssigned: rowCount === 0 };
}

export async function unassignProfessor(batchId, professorId, actor) {
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `DELETE FROM batch_professors bp USING users u, batches b
        WHERE bp.batch_id = $1 AND bp.professor_id = $2 AND u.id = bp.professor_id AND b.id = bp.batch_id
        RETURNING u.full_name, b.name`,
      [batchId, professorId],
    );
    if (!rows[0]) throw notFound('Professor in this batch');
    await logActivity(
      {
        actorId: actor.id,
        action: 'batch.professor_unassigned',
        entityType: 'batch',
        entityId: batchId,
        description: `${rows[0].full_name} removed from ${rows[0].name}`,
        metadata: { professorId },
      },
      db,
    );
  });
}

// ─── Learning material availability ─────────────────────────────────────

/** Check that every selected batch takes the course; returns the cleaned list. */
export async function assertAvailabilityBatches(courseId, batchIds, db) {
  const outside = await batchesOutsideCourse(courseId, batchIds, db);
  if (outside.length) throw invalid('batchIds', `${outside.map((b) => b.name).join(', ')} does not take this course`);
  return [...new Set(batchIds)];
}

const MATERIAL = {
  module: { sql: 'SELECT id, title, course_id FROM modules WHERE id = $1', label: 'Module' },
  video: { sql: 'SELECT id, title, course_id FROM videos WHERE id = $1', label: 'Video' },
};

/** Restrict a module or video to some batches (an empty list makes it available to every student of the course). */
export async function setAvailability(kind, id, batchIds, actor) {
  return withTransaction(async (db) => {
    const { rows } = await db.query(MATERIAL[kind].sql, [id]);
    const item = rows[0];
    if (!item) throw notFound(MATERIAL[kind].label);
    const ids = await assertAvailabilityBatches(item.course_id, batchIds, db);
    await replaceAvailability(kind, id, ids, db);
    await logActivity(
      {
        actorId: actor.id,
        action: `${kind}.availability_changed`,
        entityType: kind,
        entityId: id,
        description: ids.length
          ? `${MATERIAL[kind].label} "${item.title}" restricted to ${ids.length} batch${ids.length === 1 ? '' : 'es'}`
          : `${MATERIAL[kind].label} "${item.title}" made available to every batch`,
        metadata: { batchIds: ids },
      },
      db,
    );
    return { id, batchIds: ids };
  });
}
