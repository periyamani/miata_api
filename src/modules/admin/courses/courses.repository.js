import { pool } from '../../../config/db.js';
import { availabilityColumn } from '../../../repositories/batches.repository.js';
import { TEACHING_STATUS_COLUMNS, TEACHING_STATUS_JOIN } from '../../../repositories/moduleStatus.repository.js';
import { professorCoursePredicate, studentCoursePredicate, studentModulePredicate } from '../../../repositories/scope.js';
import { limitOffset, orderBy, paged, SqlBuilder } from '../../../utils/sql.js';

const COURSE_COUNTS = `
  (SELECT count(*) FROM modules m WHERE m.course_id = c.id) AS module_count,
  (SELECT count(*) FROM course_enrolments e WHERE e.course_id = c.id) AS student_count,
  (SELECT count(*) FROM course_enrolments e WHERE e.course_id = c.id AND e.status = 'completed') AS completed_count,
  (SELECT count(*) FROM professor_course_assignments p WHERE p.course_id = c.id) AS professor_count,
  (SELECT count(*) FROM batch_courses bc WHERE bc.course_id = c.id) AS batch_count,
  (SELECT count(*) FROM videos v WHERE v.course_id = c.id) AS video_count,
  (SELECT count(*) FROM assignments a WHERE a.course_id = c.id) AS assignment_count`;

const SORTS = { title: 'c.title', code: 'c.code', created_at: 'c.created_at', students: 'student_count' };

export async function listCourses({ page, pageSize, search, sort, order, status }) {
  const q = new SqlBuilder();
  q.search(search, ['c.title', 'c.code', 'c.category']);
  if (status) q.where(`c.is_active = ${q.param(status === 'active')}`);
  return paged(
    pool,
    `SELECT c.*, ${COURSE_COUNTS}, count(*) OVER () AS total_count
       FROM courses c ${q.whereClause()}
       ${orderBy(sort, order, SORTS, 'created_at')}
       ${limitOffset(q, { page, pageSize })}`,
    q.params,
  );
}

export async function findCourse(id, db = pool) {
  const { rows } = await db.query(`SELECT c.*, ${COURSE_COUNTS} FROM courses c WHERE c.id = $1`, [id]);
  return rows[0] || null;
}

/** Modules (ordered) with their lessons (ordered), module professors, content counts, batch availability and teaching status. */
export async function courseCurriculum(courseId, db = pool) {
  const { rows: modules } = await db.query(
    `SELECT m.*, ${TEACHING_STATUS_COLUMNS},
            (SELECT count(*) FROM videos v WHERE v.module_id = m.id) AS video_count,
            (SELECT count(*) FROM assignments a WHERE a.module_id = m.id) AS assignment_count,
            COALESCE((SELECT json_agg(json_build_object('id', u.id, 'full_name', u.full_name) ORDER BY u.full_name)
                        FROM professor_module_assignments pma JOIN users u ON u.id = pma.professor_id
                       WHERE pma.module_id = m.id), '[]') AS professors,
            ${availabilityColumn('module', 'm.id')} AS batches
       FROM modules m ${TEACHING_STATUS_JOIN} WHERE m.course_id = $1 ORDER BY m.position, m.id`,
    [courseId],
  );
  const { rows: lessons } = await db.query(
    `SELECT l.*, cl.lecturer_name, (SELECT count(*) FROM videos v WHERE v.lesson_id = l.id) AS video_count
       FROM lessons l JOIN modules m ON m.id = l.module_id
       LEFT JOIN course_lecturers cl ON cl.id = l.course_lecturer_id
      WHERE m.course_id = $1 ORDER BY l.position, l.id`,
    [courseId],
  );
  return modules.map((m) => ({ ...m, lessons: lessons.filter((l) => l.module_id === m.id) }));
}

export async function courseProfessors(courseId, db = pool) {
  const { rows } = await db.query(
    `SELECT u.id, u.full_name, u.email, u.is_active, pp.employee_code, pp.specialization, pca.assigned_at
       FROM professor_course_assignments pca
       JOIN users u ON u.id = pca.professor_id
       LEFT JOIN professor_profiles pp ON pp.user_id = u.id
      WHERE pca.course_id = $1 ORDER BY u.full_name`,
    [courseId],
  );
  return rows;
}

/** Batches taking the course, with how many of their students are enrolled in it. */
export async function courseBatches(courseId, db = pool) {
  const { rows } = await db.query(
    `SELECT b.id, b.code, b.name, b.is_active, b.start_date, b.end_date, bc.added_at,
            (SELECT count(*) FROM batch_students bs WHERE bs.batch_id = b.id) AS student_count,
            (SELECT string_agg(u.full_name, ', ' ORDER BY u.full_name) FROM batch_professors bp JOIN users u ON u.id = bp.professor_id
              WHERE bp.batch_id = b.id) AS professor_names
       FROM batch_courses bc JOIN batches b ON b.id = bc.batch_id
      WHERE bc.course_id = $1 ORDER BY b.is_active DESC, b.start_date DESC NULLS LAST, b.name`,
    [courseId],
  );
  return rows;
}

const STUDENT_SORTS = { full_name: 'u.full_name', enrolled_at: 'e.enrolled_at', status: 'e.status' };

/** Enrolled students with raw progress counts (the service applies the completion policy). */
export async function courseStudents(courseId, { page, pageSize, search, sort, order, status }) {
  const q = new SqlBuilder();
  q.where(`e.course_id = ${q.param(courseId)}`);
  q.search(search, ['u.full_name', 'u.email', 'sp.student_code']);
  if (status) q.where(`e.status = ${q.param(status)}`);
  return paged(
    pool,
    `SELECT e.id AS enrolment_id, e.status, e.enrolled_at, e.completed_at,
            u.id AS student_id, u.full_name, u.email, u.is_active, sp.student_code,
            ep.videos_total, ep.videos_done, ep.assignments_total, ep.assignments_done,
            count(*) OVER () AS total_count
       FROM course_enrolments e
       JOIN users u ON u.id = e.student_id
       LEFT JOIN student_profiles sp ON sp.user_id = u.id
       JOIN enrolment_progress ep ON ep.enrolment_id = e.id
       ${q.whereClause()}
       ${orderBy(sort, order, STUDENT_SORTS, 'enrolled_at')}
       ${limitOffset(q, { page, pageSize })}`,
    q.params,
  );
}

export async function insertCourse(data, userId, db) {
  const { rows } = await db.query(
    `INSERT INTO courses (code, title, description, category, duration_value, duration_unit, fee_amount, is_active, created_by,
                          academic_year, start_date, end_date, schedule_notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
    [
      data.code,
      data.title,
      data.description,
      data.category,
      data.durationValue,
      data.durationUnit,
      data.feeAmount,
      data.isActive,
      userId,
      data.academicYear ?? null,
      data.startDate ?? null,
      data.endDate ?? null,
      data.scheduleNotes ?? null,
    ],
  );
  return rows[0];
}

export async function updateCourse(id, data, db) {
  const { rows } = await db.query(
    `UPDATE courses SET code = $2, title = $3, description = $4, category = $5,
            duration_value = $6, duration_unit = $7, fee_amount = $8, is_active = $9,
            academic_year = $10, start_date = $11, end_date = $12, schedule_notes = $13
      WHERE id = $1 RETURNING *`,
    [
      id,
      data.code,
      data.title,
      data.description,
      data.category,
      data.durationValue,
      data.durationUnit,
      data.feeAmount,
      data.isActive,
      data.academicYear,
      data.startDate,
      data.endDate,
      data.scheduleNotes,
    ],
  );
  return rows[0] || null;
}

/** Fill in timetable fields a course does not have yet (an import never overwrites what an admin entered). */
export async function fillCourseSchedule(id, data, db) {
  const { rows } = await db.query(
    `UPDATE courses SET
            description = COALESCE(description, $2),
            academic_year = COALESCE(academic_year, $3),
            start_date = COALESCE(start_date, $4),
            end_date = COALESCE(end_date, $5),
            schedule_notes = COALESCE(schedule_notes, $6),
            duration_value = COALESCE(duration_value, $7),
            duration_unit = CASE WHEN duration_value IS NULL THEN $8 ELSE duration_unit END
      WHERE id = $1
        AND (description IS NULL OR academic_year IS NULL OR start_date IS NULL OR end_date IS NULL
             OR schedule_notes IS NULL OR duration_value IS NULL)
      RETURNING *`,
    [id, data.description, data.academicYear, data.startDate, data.endDate, data.scheduleNotes, data.durationValue, data.durationUnit],
  );
  return rows[0] || null;
}

// A module's number is its place in the course (positions may have gaps after deletions).
const MODULE_NUMBER = `(SELECT count(*) FROM modules mn WHERE mn.course_id = m.course_id AND (mn.position, mn.id) <= (m.position, m.id))`;

/** The course's modules in order, numbered, with their scheduled sessions' count and first / last week. */
export async function courseModuleSchedule(courseId, db = pool) {
  const { rows } = await db.query(
    `SELECT m.id, m.title, ${MODULE_NUMBER} AS module_number,
            (SELECT count(*) FROM lessons l WHERE l.module_id = m.id AND l.week_number IS NULL) AS topic_count,
            (SELECT count(*) FROM lessons l WHERE l.module_id = m.id AND l.week_number IS NOT NULL) AS session_count,
            (SELECT min(l.week_number) FROM lessons l WHERE l.module_id = m.id) AS first_week,
            (SELECT max(l.week_number) FROM lessons l WHERE l.module_id = m.id) AS last_week
       FROM modules m WHERE m.course_id = $1 ORDER BY m.position, m.id`,
    [courseId],
  );
  return rows;
}

/**
 * Scheduled sessions (lessons with a week) of the course, week by week in lecturer order, with module and lecturer.
 * With `studentId`, only sessions of modules available to that student (a module may be restricted to other batches).
 */
export async function courseSessions(courseId, { studentId = null } = {}, db = pool) {
  const { rows } = await db.query(
    `SELECT l.id, l.title, l.week_number, l.duration_minutes, l.module_id, m.title AS module_title, ${MODULE_NUMBER} AS module_number,
            l.course_lecturer_id, cl.lecturer_name
       FROM lessons l JOIN modules m ON m.id = l.module_id
       LEFT JOIN course_lecturers cl ON cl.id = l.course_lecturer_id
      WHERE m.course_id = $1 AND l.week_number IS NOT NULL
        AND ($2::bigint IS NULL OR ${studentModulePredicate('m.id', '$2::bigint')})
      ORDER BY l.week_number, cl.position NULLS LAST, cl.id, m.position, l.position, l.id`,
    [courseId, studentId],
  );
  return rows;
}

const HAS_SESSIONS = `EXISTS (SELECT 1 FROM lessons l JOIN modules m ON m.id = l.module_id WHERE m.course_id = c.id AND l.week_number IS NOT NULL)`;

/**
 * Active courses with a timetable that a professor may see: they lecture in it (a course lecturer linked to them), or
 * they may see the course already (course or module professor, or professor of a batch that takes it).
 */
export async function professorTimetableCourseIds(professorId, db = pool) {
  const { rows } = await db.query(
    `SELECT c.id FROM courses c
      WHERE c.is_active AND ${HAS_SESSIONS}
        AND (EXISTS (SELECT 1 FROM course_lecturers cl WHERE cl.course_id = c.id AND cl.professor_id = $1)
             OR ${professorCoursePredicate('c.id', '$1')})
      ORDER BY c.start_date DESC NULLS LAST, c.title`,
    [professorId],
  );
  return rows.map((r) => r.id);
}

/** Courses with a timetable that the student is enrolled in (active or completed, course active). */
export async function studentTimetableCourseIds(studentId, db = pool) {
  const { rows } = await db.query(
    `SELECT c.id FROM courses c WHERE ${HAS_SESSIONS} AND ${studentCoursePredicate('c.id', '$1')}
      ORDER BY c.start_date DESC NULLS LAST, c.title`,
    [studentId],
  );
  return rows.map((r) => r.id);
}

/** The latest programme week any of the course's topics is taught in (0 when none is scheduled). */
export async function lastScheduledWeek(courseId, db = pool) {
  const { rows } = await db.query(
    `SELECT COALESCE(max(l.week_number), 0)::int AS week FROM lessons l JOIN modules m ON m.id = l.module_id WHERE m.course_id = $1`,
    [courseId],
  );
  return rows[0].week;
}

export async function setCourseActive(id, isActive, db) {
  const { rows } = await db.query('UPDATE courses SET is_active = $2 WHERE id = $1 RETURNING *', [id, isActive]);
  return rows[0] || null;
}

export async function codeTaken(code, exceptId, db = pool) {
  const { rowCount } = await db.query('SELECT 1 FROM courses WHERE code = $1 AND id IS DISTINCT FROM $2', [code, exceptId]);
  return rowCount > 0;
}
