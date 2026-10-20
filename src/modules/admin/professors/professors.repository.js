import { pool } from '../../../config/db.js';
import { professorCoursePredicate, professorStudentPredicate, professorSubmissionPredicate } from '../../../repositories/scope.js';
import { limitOffset, orderBy, paged, SqlBuilder } from '../../../utils/sql.js';

// Workload figures reuse the same scope predicates the professor portal enforces.
const WORKLOAD = `
  (SELECT count(*) FROM professor_course_assignments x WHERE x.professor_id = u.id) AS course_count,
  (SELECT count(*) FROM professor_module_assignments x WHERE x.professor_id = u.id) AS module_count,
  (SELECT count(*) FROM batch_professors x WHERE x.professor_id = u.id) AS batch_count,
  (SELECT string_agg(c.title, ', ' ORDER BY c.title) FROM professor_course_assignments x JOIN courses c ON c.id = x.course_id
    WHERE x.professor_id = u.id) AS course_titles,
  (SELECT string_agg(b.name, ', ' ORDER BY b.name) FROM batch_professors x JOIN batches b ON b.id = x.batch_id
    WHERE x.professor_id = u.id) AS batch_names,
  (SELECT count(DISTINCT e.student_id) FROM course_enrolments e
    WHERE e.status IN ('active', 'completed') AND ${professorStudentPredicate('e.student_id', 'e.course_id', 'u.id')}) AS student_count,
  (SELECT count(*) FROM assignment_submissions s JOIN assignments a ON a.id = s.assignment_id
    WHERE s.status IN ('submitted', 'in_review') AND ${professorSubmissionPredicate('s', 'a', 'u.id')}) AS pending_reviews`;

const SORTS = { full_name: 'u.full_name', created_at: 'u.created_at', pending_reviews: 'pending_reviews' };

export async function listProfessors({ page, pageSize, search, sort, order, status, courseId }) {
  const q = new SqlBuilder();
  q.where(`u.role = 'professor'`);
  q.search(search, ['u.full_name', 'u.email', 'pp.employee_code', 'pp.department', 'pp.specialization']);
  if (status) q.where(`u.is_active = ${q.param(status === 'active')}`);
  if (courseId) q.where(professorCoursePredicate(q.param(courseId), 'u.id'));
  return paged(
    pool,
    `SELECT u.id, u.full_name, u.email, u.phone, u.is_active, u.created_at, u.last_login_at,
            pp.employee_code, pp.department, pp.specialization, ${WORKLOAD},
            count(*) OVER () AS total_count
       FROM users u LEFT JOIN professor_profiles pp ON pp.user_id = u.id
       ${q.whereClause()}
       ${orderBy(sort, order, SORTS, 'created_at')}
       ${limitOffset(q, { page, pageSize })}`,
    q.params,
  );
}

export async function professorWorkload(professorId) {
  const { rows } = await pool.query(
    `SELECT ${WORKLOAD},
       (SELECT count(*) FROM assignment_submissions s JOIN assignments a ON a.id = s.assignment_id
         WHERE s.status = 'completed' AND ${professorSubmissionPredicate('s', 'a', 'u.id')}) AS completed_reviews,
       (SELECT count(*) FROM assignment_submissions s JOIN assignments a ON a.id = s.assignment_id
         WHERE s.status = 'rework' AND ${professorSubmissionPredicate('s', 'a', 'u.id')}) AS rework_count
     FROM users u WHERE u.id = $1`,
    [professorId],
  );
  return rows[0];
}

export async function professorCourses(professorId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.code, c.is_active, pca.assigned_at,
            (SELECT count(*) FROM course_enrolments e WHERE e.course_id = c.id AND e.status IN ('active', 'completed')) AS student_count
       FROM professor_course_assignments pca JOIN courses c ON c.id = pca.course_id
      WHERE pca.professor_id = $1 ORDER BY c.title`,
    [professorId],
  );
  return rows;
}

export async function professorModules(professorId) {
  const { rows } = await pool.query(
    `SELECT m.id, m.title, m.course_id, c.title AS course_title, pma.assigned_at
       FROM professor_module_assignments pma JOIN modules m ON m.id = pma.module_id JOIN courses c ON c.id = m.course_id
      WHERE pma.professor_id = $1 ORDER BY c.title, m.position`,
    [professorId],
  );
  return rows;
}

export async function recentReviews(professorId, limit = 10) {
  const { rows } = await pool.query(
    `SELECT r.id, r.decision, r.feedback, r.created_at, a.title AS assignment_title, u.full_name AS student_name, s.id AS submission_id
       FROM assignment_reviews r
       JOIN assignment_submissions s ON s.id = r.submission_id
       JOIN assignments a ON a.id = s.assignment_id
       JOIN users u ON u.id = s.student_id
      WHERE r.professor_id = $1 ORDER BY r.created_at DESC LIMIT $2`,
    [professorId, limit],
  );
  return rows;
}

/** Batches the professor teaches, with their size and courses. */
export async function professorBatches(professorId) {
  const { rows } = await pool.query(
    `SELECT b.id, b.code, b.name, b.is_active, b.start_date, b.end_date, bp.assigned_at,
            (SELECT count(*) FROM batch_students bs WHERE bs.batch_id = b.id) AS student_count,
            (SELECT string_agg(c.title, ', ' ORDER BY c.title) FROM batch_courses bc JOIN courses c ON c.id = bc.course_id
              WHERE bc.batch_id = b.id) AS course_titles
       FROM batch_professors bp JOIN batches b ON b.id = bp.batch_id
      WHERE bp.professor_id = $1 ORDER BY b.is_active DESC, b.name`,
    [professorId],
  );
  return rows;
}
