import { withTransaction } from '../../../config/db.js';
import { AppError, conflict, notFound } from '../../../utils/AppError.js';
import { logActivity } from '../../../services/activity.service.js';
import * as repo from './courses.repository.js';
import * as lecturers from './lecturers.repository.js';
import { assignWithin } from '../teaching/teaching.service.js';

// A course's lecturers: who teaches its weekly sessions (name exactly as on the timetable, optionally linked to their
// professor account) and their delivery pattern. Removing a lecturer keeps their sessions, without a lecturer.
// A linked lecturer's professor is assigned to the modules in which the lecturer teaches (the timetable's allocation);
// assignments are only ever added here, never removed.

const invalid = (field, message) => new AppError(422, 'VALIDATION_ERROR', message, { [field]: message });

async function assertLecturer(db, courseId, data, exceptId = null) {
  if (await lecturers.nameTaken(courseId, data.lecturerName, exceptId, db)) {
    throw conflict('This lecturer is already on the course', { lecturerName: 'This lecturer is already on the course' });
  }
  if (data.professorId) {
    const professor = await lecturers.findProfessor(data.professorId, db);
    if (!professor) throw invalid('professorId', 'This user is not a professor');
    if (!professor.is_active) throw invalid('professorId', 'This professor account is deactivated');
  }
}

/**
 * Assign each linked lecturer's professor to the modules in which they teach weekly sessions, through the regular
 * module assignment (notification and activity log included). Returns the assignments added.
 */
export async function assignLecturerModules(db, courseId, actor) {
  const missing = await lecturers.missingModuleAssignments(courseId, db);
  for (const a of missing) await assignWithin(db, 'module', a.module_id, a.professor_id, actor);
  return missing;
}

const log = (db, actor, courseId, action, description) =>
  logActivity({ actorId: actor.id, action, entityType: 'course', entityId: courseId, description }, db);

export async function addLecturer(courseId, data, actor) {
  return withTransaction(async (db) => {
    const course = await repo.findCourse(courseId, db);
    if (!course) throw notFound('Course');
    await assertLecturer(db, courseId, data);
    const lecturer = await lecturers.insertLecturer(courseId, data, db);
    await log(db, actor, courseId, 'course.lecturer_added', `${data.lecturerName} added to ${course.title}`);
    await assignLecturerModules(db, courseId, actor);
    return lecturer;
  });
}

export async function updateLecturer(id, data, actor) {
  return withTransaction(async (db) => {
    const existing = await lecturers.findLecturer(id, db);
    if (!existing) throw notFound('Lecturer');
    await assertLecturer(db, existing.course_id, data, id);
    const lecturer = await lecturers.updateLecturer(id, data, db);
    await log(db, actor, existing.course_id, 'course.lecturer_updated', `${data.lecturerName} updated on ${existing.course_title}`);
    await assignLecturerModules(db, existing.course_id, actor);
    return lecturer;
  });
}

export async function deleteLecturer(id, actor) {
  return withTransaction(async (db) => {
    const existing = await lecturers.findLecturer(id, db);
    if (!existing) throw notFound('Lecturer');
    await lecturers.deleteLecturer(id, db);
    await log(
      db,
      actor,
      existing.course_id,
      'course.lecturer_removed',
      `${existing.lecturer_name} removed from ${existing.course_title} (${existing.session_count} session(s) kept without a lecturer)`,
    );
  });
}
