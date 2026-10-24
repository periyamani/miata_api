import { withTransaction } from '../../../config/db.js';
import { AppError, notFound } from '../../../utils/AppError.js';
import { logActivity } from '../../../services/activity.service.js';
import { notifyUsers } from '../../../services/notification.service.js';

async function findActiveProfessor(professorId, db) {
  const { rows } = await db.query(`SELECT id, full_name, is_active FROM users WHERE id = $1 AND role = 'professor'`, [professorId]);
  const professor = rows[0];
  if (!professor) throw new AppError(422, 'VALIDATION_ERROR', 'Select a professor', { professorId: 'This user is not a professor' });
  if (!professor.is_active)
    throw new AppError(422, 'VALIDATION_ERROR', 'This professor account is deactivated', { professorId: 'Professor is deactivated' });
  return professor;
}

/**
 * A course with lecturers (its timetable, migration 016) has its modules taught by them: only a professor linked to one of
 * the course's lecturers can be assigned to its modules. Courses without lecturers accept any professor, as before.
 */
async function assertCourseLecturer(db, courseId, professorId) {
  const { rows } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM course_lecturers WHERE course_id = $1) AS has_lecturers,
            EXISTS (SELECT 1 FROM course_lecturers WHERE course_id = $1 AND professor_id = $2) AS is_lecturer`,
    [courseId, professorId],
  );
  if (rows[0].has_lecturers && !rows[0].is_lecturer) {
    const message = 'Only the course’s lecturers can be assigned to its modules';
    throw new AppError(422, 'VALIDATION_ERROR', message, { professorId: message });
  }
}

const TARGETS = {
  course: {
    find: 'SELECT id, title, id AS course_id FROM courses WHERE id = $1',
    insert: `INSERT INTO professor_course_assignments (professor_id, course_id, assigned_by) VALUES ($1, $2, $3)
             ON CONFLICT (professor_id, course_id) DO NOTHING RETURNING id`,
    remove: 'DELETE FROM professor_course_assignments WHERE professor_id = $1 AND course_id = $2',
    label: 'Course',
  },
  module: {
    find: `SELECT m.id, m.title || ' (' || c.title || ')' AS title, m.course_id
             FROM modules m JOIN courses c ON c.id = m.course_id WHERE m.id = $1`,
    insert: `INSERT INTO professor_module_assignments (professor_id, module_id, assigned_by) VALUES ($1, $2, $3)
             ON CONFLICT (professor_id, module_id) DO NOTHING RETURNING id`,
    remove: 'DELETE FROM professor_module_assignments WHERE professor_id = $1 AND module_id = $2',
    label: 'Module',
  },
};

/** Assign a professor to a course (all its assignments) or to one module (that module's assignments). */
export const assign = (kind, targetId, professorId, actor) => withTransaction((db) => assignWithin(db, kind, targetId, professorId, actor));

/** Same as `assign`, inside the caller's transaction (e.g. while creating the professor account). */
export async function assignWithin(db, kind, targetId, professorId, actor) {
  const t = TARGETS[kind];
  const { rows } = await db.query(t.find, [targetId]);
  const target = rows[0];
  if (!target) throw notFound(t.label);
  const professor = await findActiveProfessor(professorId, db);
  if (kind === 'module') await assertCourseLecturer(db, target.course_id, professorId);
  const { rowCount } = await db.query(t.insert, [professorId, targetId, actor.id]);
  if (rowCount) {
    await notifyUsers(
      [professorId],
      { type: 'teaching_assigned', title: `You have been assigned to ${target.title}`, link: '/professor/assignments' },
      db,
    );
    await logActivity(
      {
        actorId: actor.id,
        action: `professor.assigned_${kind}`,
        entityType: kind,
        entityId: targetId,
        description: `${professor.full_name} assigned to ${target.title}`,
        metadata: { professorId },
      },
      db,
    );
  }
  return { assigned: true, alreadyAssigned: rowCount === 0 };
}

export async function unassign(kind, targetId, professorId, actor) {
  const t = TARGETS[kind];
  return withTransaction(async (db) => {
    const { rowCount } = await db.query(t.remove, [professorId, targetId]);
    if (!rowCount) throw notFound('Assignment of this professor');
    await logActivity(
      {
        actorId: actor.id,
        action: `professor.unassigned_${kind}`,
        entityType: kind,
        entityId: targetId,
        description: `Professor #${professorId} unassigned from ${kind} #${targetId}`,
        metadata: { professorId },
      },
      db,
    );
  });
}
