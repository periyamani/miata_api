import { AppError, notFound } from '../../../utils/AppError.js';
import { addDays, daysBetween, today, weeksInRange } from '../../../utils/dates.js';
import * as repo from './courses.repository.js';
import { courseLecturers } from './lecturers.repository.js';

// A course's weekly timetable, read from the course structure: programme dates on the course, lecturers on the course,
// sessions as lessons with a week number and lecturer, each in its curriculum module. Week dates and the current week
// are derived (in APP_TIMEZONE). A lecturer's stream ends with their last session; nothing is padded.
// The same timetable serves every role: admins (any course, filters), professors (the courses they teach or lecture in)
// and students (their enrolled courses, sessions of modules available to them); only admins get account details.

const invalid = (field, message) => new AppError(422, 'VALIDATION_ERROR', message, { [field]: message });

const COURSE_FIELDS = ['id', 'code', 'title', 'description', 'academic_year', 'start_date', 'end_date', 'schedule_notes'];
// What professors and students see of a lecturer (no account or e-mail details).
const LECTURER_FIELDS = [
  'id',
  'lecturer_name',
  'allocation',
  'delivery_day',
  'start_time',
  'end_time',
  'session_minutes',
  'position',
  'first_week',
  'last_week',
  'session_count',
];
const pick = (row, fields) => Object.fromEntries(fields.map((k) => [k, row[k]]));

/** Weeks (dates, sessions), current week and status from the course, its sessions, lecturers and modules. */
function buildTimetable(course, sessions, lecturers, modules, { week, moduleId, lecturerId } = {}) {
  const lastScheduled = sessions.reduce((max, s) => Math.max(max, s.week_number), 0);
  const dated = course.start_date && course.end_date ? weeksInRange(course.start_date, course.end_date) : 0;
  const weekCount = Math.max(dated, lastScheduled);

  let currentWeek = null;
  let status = 'undated';
  const now = today();
  if (course.start_date && weekCount) {
    const offset = daysBetween(course.start_date, now);
    if (offset < 0) status = 'upcoming';
    else if (offset < weekCount * 7) {
      status = 'running';
      currentWeek = Math.floor(offset / 7) + 1;
    } else status = 'finished';
  }

  const shown = sessions.filter((s) => (!moduleId || s.module_id === moduleId) && (!lecturerId || s.course_lecturer_id === lecturerId));
  const numbers = week ? (week <= weekCount ? [week] : []) : Array.from({ length: weekCount }, (_, i) => i + 1);
  const weeks = numbers.map((number) => ({
    number,
    starts_on: course.start_date ? addDays(course.start_date, (number - 1) * 7) : null,
    ends_on: course.start_date ? addDays(course.start_date, (number - 1) * 7 + 6) : null,
    sessions: shown.filter((s) => s.week_number === number),
  }));

  return {
    course: pick(course, COURSE_FIELDS),
    today: now,
    week_count: weekCount,
    current_week: currentWeek,
    status,
    lecturers,
    modules,
    weeks,
    filters: { week: week ?? null, module_id: moduleId ?? null, lecturer_id: lecturerId ?? null },
  };
}

/**
 * Admin: the timetable, optionally narrowed to one week, module or lecturer. Lecturers and modules always come complete
 * (for filters and allocations), with their first / last week over the whole timetable.
 */
export async function getTimetable(courseId, filters = {}) {
  const course = await repo.findCourse(courseId);
  if (!course) throw notFound('Course');
  const [sessions, lecturers, modules] = await Promise.all([
    repo.courseSessions(courseId),
    courseLecturers(courseId),
    repo.courseModuleSchedule(courseId),
  ]);
  if (filters.moduleId && !modules.some((m) => m.id === filters.moduleId))
    throw invalid('moduleId', 'This module is not part of the course');
  if (filters.lecturerId && !lecturers.some((l) => l.id === filters.lecturerId)) {
    throw invalid('lecturerId', 'This lecturer does not teach the course');
  }
  return buildTimetable(course, sessions, lecturers, modules, filters);
}

/** A course's timetable for a professor or student: lecturers without account details; sessions filtered for a student. */
async function portalTimetable(courseId, { studentId = null } = {}) {
  const [course, sessions, lecturers, modules] = await Promise.all([
    repo.findCourse(courseId),
    repo.courseSessions(courseId, { studentId }),
    courseLecturers(courseId),
    repo.courseModuleSchedule(courseId),
  ]);
  const visibleModules = studentId ? modules.filter((m) => sessions.some((s) => s.module_id === m.id)) : modules;
  return {
    timetable: buildTimetable(
      course,
      sessions,
      lecturers.map((l) => pick(l, LECTURER_FIELDS)),
      visibleModules,
    ),
    lecturers,
  };
}

/**
 * Professor: the timetables of the active courses they lecture in or teach; `my_lecturer_ids` marks the lecturers linked
 * to their account (their own sessions).
 */
export async function professorTimetables(professorId) {
  const courseIds = await repo.professorTimetableCourseIds(professorId);
  const results = await Promise.all(courseIds.map((id) => portalTimetable(id)));
  return results.map(({ timetable, lecturers }) => ({
    ...timetable,
    my_lecturer_ids: lecturers.filter((l) => l.professor_id === professorId).map((l) => l.id),
  }));
}

/** Student: the timetables of the courses they are enrolled in, with the sessions of modules available to them. */
export async function studentTimetables(studentId) {
  const courseIds = await repo.studentTimetableCourseIds(studentId);
  const results = await Promise.all(courseIds.map((id) => portalTimetable(id, { studentId })));
  return results.map(({ timetable }) => timetable);
}
