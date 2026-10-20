import { pool } from '../../../config/db.js';
import { availabilityColumn } from '../../../repositories/batches.repository.js';
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

/** Modules (ordered) with their lessons (ordered), module professors, content counts and batch availability. */
export async function courseCurriculum(courseId, db = pool) {
  const { rows: modules } = await db.query(
    `SELECT m.*,
            (SELECT count(*) FROM videos v WHERE v.module_id = m.id) AS video_count,
            (SELECT count(*) FROM assignments a WHERE a.module_id = m.id) AS assignment_count,
            COALESCE((SELECT json_agg(json_build_object('id', u.id, 'full_name', u.full_name) ORDER BY u.full_name)
                        FROM professor_module_assignments pma JOIN users u ON u.id = pma.professor_id
                       WHERE pma.module_id = m.id), '[]') AS professors,
            ${availabilityColumn('module', 'm.id')} AS batches
       FROM modules m WHERE m.course_id = $1 ORDER BY m.position, m.id`,
    [courseId],
  );
  const { rows: lessons } = await db.query(
    `SELECT l.*, (SELECT count(*) FROM videos v WHERE v.lesson_id = l.id) AS video_count
       FROM lessons l JOIN modules m ON m.id = l.module_id
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
    `INSERT INTO courses (code, title, description, category, duration_value, duration_unit, fee_amount, is_active, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [data.code, data.title, data.description, data.category, data.durationValue, data.durationUnit, data.feeAmount, data.isActive, userId],
  );
  return rows[0];
}

export async function updateCourse(id, data, db) {
  const { rows } = await db.query(
    `UPDATE courses SET code = $2, title = $3, description = $4, category = $5,
            duration_value = $6, duration_unit = $7, fee_amount = $8, is_active = $9
      WHERE id = $1 RETURNING *`,
    [id, data.code, data.title, data.description, data.category, data.durationValue, data.durationUnit, data.feeAmount, data.isActive],
  );
  return rows[0] || null;
}

export async function setCourseActive(id, isActive, db) {
  const { rows } = await db.query('UPDATE courses SET is_active = $2 WHERE id = $1 RETURNING *', [id, isActive]);
  return rows[0] || null;
}

export async function codeTaken(code, exceptId, db = pool) {
  const { rowCount } = await db.query('SELECT 1 FROM courses WHERE code = $1 AND id IS DISTINCT FROM $2', [code, exceptId]);
  return rowCount > 0;
}
