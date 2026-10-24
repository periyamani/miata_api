import { withTransaction } from '../../../config/db.js';
import { AppError, badRequest, conflict, notFound } from '../../../utils/AppError.js';
import { weeksInRange } from '../../../utils/dates.js';
import { logActivity } from '../../../services/activity.service.js';
import { attachProgress } from '../../../services/progress.service.js';
import { getCompletionPolicy } from '../../../services/settings.service.js';
import * as repo from './courses.repository.js';
import * as curriculum from './curriculum.repository.js';
import { courseLecturers } from './lecturers.repository.js';
import { assignLecturerModules } from './lecturers.service.js';

const codeConflict = () => conflict('A course with this code already exists', { code: 'This course code is already in use' });
const invalid = (field, message) => new AppError(422, 'VALIDATION_ERROR', message, { [field]: message });

/**
 * A lesson's schedule: its week must fall within the course's programme dates (when it has both), and a lecturer — who
 * must be one of the course's lecturers — teaches a scheduled session, so it needs a week.
 */
async function assertSchedule(db, { weekNumber, courseLecturerId }, { courseId, startDate, endDate }) {
  if (weekNumber && startDate && endDate) {
    const weeks = weeksInRange(startDate, endDate);
    if (weekNumber > weeks) throw invalid('weekNumber', `The course runs for ${weeks} week${weeks === 1 ? '' : 's'}`);
  }
  if (courseLecturerId) {
    if (!(await curriculum.lecturerInCourse(courseLecturerId, courseId, db))) {
      throw invalid('courseLecturerId', 'Choose one of the course’s lecturers');
    }
    if (!weekNumber) throw invalid('weekNumber', 'Choose the week in which the lecturer teaches this session');
  }
}

export const listCourses = (query) => repo.listCourses(query);

export async function getCourse(id) {
  const course = await repo.findCourse(id);
  if (!course) throw notFound('Course');
  const [modules, professors, batches, lecturers] = await Promise.all([
    repo.courseCurriculum(id),
    repo.courseProfessors(id),
    repo.courseBatches(id),
    courseLecturers(id),
  ]);
  return { ...course, modules, professors, batches, lecturers };
}

export async function listCourseStudents(courseId, query) {
  if (!(await repo.findCourse(courseId))) throw notFound('Course');
  const [result, policy] = await Promise.all([repo.courseStudents(courseId, query), getCompletionPolicy()]);
  return { ...result, rows: attachProgress(result.rows, policy) };
}

export async function createCourse(data, actor) {
  return withTransaction(async (db) => {
    if (await repo.codeTaken(data.code, null, db)) throw codeConflict();
    const course = await repo.insertCourse(data, actor.id, db);
    await logActivity(
      {
        actorId: actor.id,
        action: 'course.created',
        entityType: 'course',
        entityId: course.id,
        description: `Course "${course.title}" created`,
      },
      db,
    );
    return course;
  });
}

export async function updateCourse(id, data, actor) {
  return withTransaction(async (db) => {
    if (await repo.codeTaken(data.code, id, db)) throw codeConflict();
    if (data.startDate && data.endDate) {
      const lastWeek = await repo.lastScheduledWeek(id, db);
      if (lastWeek > weeksInRange(data.startDate, data.endDate)) {
        throw invalid('endDate', `Topics are scheduled up to week ${lastWeek}: keep the dates long enough for them`);
      }
    }
    const course = await repo.updateCourse(id, data, db);
    if (!course) throw notFound('Course');
    await logActivity(
      { actorId: actor.id, action: 'course.updated', entityType: 'course', entityId: id, description: `Course "${course.title}" updated` },
      db,
    );
    return course;
  });
}

export async function setCourseStatus(id, isActive, actor) {
  return withTransaction(async (db) => {
    const course = await repo.setCourseActive(id, isActive, db);
    if (!course) throw notFound('Course');
    await logActivity(
      {
        actorId: actor.id,
        action: isActive ? 'course.activated' : 'course.deactivated',
        entityType: 'course',
        entityId: id,
        description: `Course "${course.title}" ${isActive ? 'activated' : 'deactivated'}`,
      },
      db,
    );
    return course;
  });
}

// ─── Modules & lessons ──────────────────────────────────────────────────

export async function addModule(courseId, data, actor) {
  return withTransaction(async (db) => {
    if (!(await repo.findCourse(courseId, db))) throw notFound('Course');
    const mod = await curriculum.insertModule(courseId, data, db);
    await logActivity(
      {
        actorId: actor.id,
        action: 'module.created',
        entityType: 'module',
        entityId: mod.id,
        description: `Module "${mod.title}" added`,
        metadata: { courseId },
      },
      db,
    );
    return mod;
  });
}

export async function updateModule(moduleId, data, actor) {
  return withTransaction(async (db) => {
    const mod = await curriculum.updateModule(moduleId, data, db);
    if (!mod) throw notFound('Module');
    await logActivity(
      {
        actorId: actor.id,
        action: 'module.updated',
        entityType: 'module',
        entityId: moduleId,
        description: `Module "${mod.title}" updated`,
      },
      db,
    );
    return mod;
  });
}

/** Lessons are deleted with the module; videos and assignments stay on the course (module cleared). */
export async function deleteModule(moduleId, actor) {
  return withTransaction(async (db) => {
    const mod = await curriculum.findModule(moduleId, db);
    if (!mod) throw notFound('Module');
    await curriculum.deleteModule(moduleId, db);
    await logActivity(
      {
        actorId: actor.id,
        action: 'module.deleted',
        entityType: 'module',
        entityId: moduleId,
        description: `Module "${mod.title}" removed from ${mod.course_title}`,
      },
      db,
    );
  });
}

async function reorder({ table, parentColumn, parentId, ids, db }) {
  const current = await curriculum.childIds(table, parentColumn, parentId, db);
  const same = current.length === ids.length && new Set(ids).size === ids.length && ids.every((i) => current.includes(i));
  if (!same) throw badRequest('The order must list every item exactly once');
  await curriculum.applyOrder(table, ids, db);
}

export async function reorderModules(courseId, ids) {
  return withTransaction((db) => reorder({ table: 'modules', parentColumn: 'course_id', parentId: courseId, ids, db }));
}

export async function addLesson(moduleId, data, actor) {
  return withTransaction(async (db) => {
    const mod = await curriculum.findModule(moduleId, db);
    if (!mod) throw notFound('Module');
    await assertSchedule(db, data, { courseId: mod.course_id, startDate: mod.course_start_date, endDate: mod.course_end_date });
    const lesson = await curriculum.insertLesson(moduleId, data, db);
    // A session taught by a linked lecturer makes their professor one of the module's professors.
    if (data.courseLecturerId) await assignLecturerModules(db, mod.course_id, actor);
    await logActivity(
      {
        actorId: actor.id,
        action: 'lesson.created',
        entityType: 'lesson',
        entityId: lesson.id,
        description: `Lesson "${lesson.title}" added to ${mod.title}`,
      },
      db,
    );
    return lesson;
  });
}

export async function updateLesson(lessonId, data, actor) {
  return withTransaction(async (db) => {
    const existing = await curriculum.findLesson(lessonId, db);
    if (!existing) throw notFound('Lesson');
    await assertSchedule(db, data, { courseId: existing.course_id, startDate: existing.course_start_date, endDate: existing.course_end_date });
    const lesson = await curriculum.updateLesson(lessonId, data, db);
    if (data.courseLecturerId) await assignLecturerModules(db, existing.course_id, actor);
    await logActivity(
      {
        actorId: actor.id,
        action: 'lesson.updated',
        entityType: 'lesson',
        entityId: lessonId,
        description: `Lesson "${lesson.title}" updated`,
      },
      db,
    );
    return lesson;
  });
}

export async function deleteLesson(lessonId, actor) {
  return withTransaction(async (db) => {
    const lesson = await curriculum.findLesson(lessonId, db);
    if (!lesson) throw notFound('Lesson');
    await curriculum.deleteLesson(lessonId, db);
    await logActivity(
      {
        actorId: actor.id,
        action: 'lesson.deleted',
        entityType: 'lesson',
        entityId: lessonId,
        description: `Lesson "${lesson.title}" deleted`,
      },
      db,
    );
  });
}

export async function reorderLessons(moduleId, ids) {
  return withTransaction((db) => reorder({ table: 'lessons', parentColumn: 'module_id', parentId: moduleId, ids, db }));
}
