import { pool } from '../config/db.js';
import { limitOffset, orderBy, paged, SqlBuilder } from '../utils/sql.js';
import { professorSubmissionPredicate, studentInBatchPredicate } from './scope.js';

const SORTS = {
  submitted_at: 's.submitted_at',
  status: 's.status',
  student: 'u.full_name',
  assignment: 'a.title',
  due_at: 'a.due_at',
};

/**
 * Submissions list shared by admin (all) and professors (`scopeProfessorId` restricts to submissions
 * they may review). `latestOnly` hides superseded attempts; `batchId` keeps one batch's students.
 */
export async function listSubmissions(filters, { scopeProfessorId = null } = {}) {
  const q = new SqlBuilder();
  if (scopeProfessorId) q.where(professorSubmissionPredicate('s', 'a', q.param(scopeProfessorId)));
  if (filters.professorId) q.where(professorSubmissionPredicate('s', 'a', q.param(filters.professorId)));
  if (filters.batchId) q.where(studentInBatchPredicate('s.student_id', q.param(filters.batchId)));
  if (filters.status) {
    const statuses = filters.status === 'pending' ? ['submitted', 'in_review'] : [filters.status];
    q.where(`s.status = ANY(${q.param(statuses)}::text[])`);
  }
  if (filters.courseId) q.where(`a.course_id = ${q.param(filters.courseId)}`);
  if (filters.assignmentId) q.where(`a.id = ${q.param(filters.assignmentId)}`);
  if (filters.studentId) q.where(`s.student_id = ${q.param(filters.studentId)}`);
  if (filters.latestOnly !== false) {
    q.where(`s.attempt_no = (SELECT max(s2.attempt_no) FROM assignment_submissions s2
                              WHERE s2.assignment_id = s.assignment_id AND s2.student_id = s.student_id)`);
  }
  q.search(filters.search, ['u.full_name', 'sp.student_code', 'a.title']);

  return paged(
    pool,
    `SELECT s.id, s.status, s.attempt_no, s.submitted_at, s.reviewed_at, s.notes,
            a.id AS assignment_id, a.title AS assignment_title, a.due_at,
            c.id AS course_id, c.title AS course_title, m.title AS module_title,
            u.id AS student_id, u.full_name AS student_name, sp.student_code,
            sb.id AS batch_id, sb.name AS batch_name, sb.code AS batch_code,
            rv.full_name AS reviewer_name,
            f.original_name AS file_name, f.size_bytes AS file_size,
            count(*) OVER () AS total_count
       FROM assignment_submissions s
       JOIN assignments a ON a.id = s.assignment_id
       JOIN courses c ON c.id = a.course_id
       LEFT JOIN modules m ON m.id = a.module_id
       JOIN users u ON u.id = s.student_id
       LEFT JOIN student_profiles sp ON sp.user_id = u.id
       LEFT JOIN batch_students sbs ON sbs.student_id = s.student_id
       LEFT JOIN batches sb ON sb.id = sbs.batch_id
       LEFT JOIN users rv ON rv.id = s.reviewed_by
       JOIN files f ON f.id = s.file_id
       ${q.whereClause()}
       ${orderBy(filters.sort, filters.order, SORTS, 'submitted_at')}
       ${limitOffset(q, filters)}`,
    q.params,
  );
}

/** Core submission row with assignment, course and file metadata (no authorisation applied). */
export async function findSubmission(id, db = pool) {
  const { rows } = await db.query(
    `SELECT s.*, a.title AS assignment_title, a.instructions, a.due_at, a.course_id, a.module_id, a.batch_id AS assignment_batch_id,
            c.title AS course_title, m.title AS module_title,
            u.full_name AS student_name, u.email AS student_email, sp.student_code,
            sb.id AS batch_id, sb.name AS batch_name, sb.code AS batch_code,
            f.original_name AS file_name, f.size_bytes AS file_size, f.mime_type AS file_mime,
            rv.full_name AS reviewer_name
       FROM assignment_submissions s
       JOIN assignments a ON a.id = s.assignment_id
       JOIN courses c ON c.id = a.course_id
       LEFT JOIN modules m ON m.id = a.module_id
       JOIN users u ON u.id = s.student_id
       LEFT JOIN student_profiles sp ON sp.user_id = u.id
       LEFT JOIN batch_students sbs ON sbs.student_id = s.student_id
       LEFT JOIN batches sb ON sb.id = sbs.batch_id
       JOIN files f ON f.id = s.file_id
       LEFT JOIN users rv ON rv.id = s.reviewed_by
      WHERE s.id = $1`,
    [id],
  );
  return rows[0] || null;
}

/** Full review context: the submission, every attempt for the same assignment, reviews and comments. */
export async function submissionThread(submission) {
  const [attempts, reviews, comments] = await Promise.all([
    pool.query(
      `SELECT s.id, s.attempt_no, s.status, s.submitted_at, s.reviewed_at, s.notes, f.original_name AS file_name, f.size_bytes AS file_size
         FROM assignment_submissions s JOIN files f ON f.id = s.file_id
        WHERE s.assignment_id = $1 AND s.student_id = $2 ORDER BY s.attempt_no DESC`,
      [submission.assignment_id, submission.student_id],
    ),
    pool.query(
      `SELECT r.id, r.submission_id, r.decision, r.feedback, r.created_at, u.full_name AS professor_name, s.attempt_no
         FROM assignment_reviews r
         JOIN users u ON u.id = r.professor_id
         JOIN assignment_submissions s ON s.id = r.submission_id
        WHERE s.assignment_id = $1 AND s.student_id = $2 ORDER BY r.created_at DESC`,
      [submission.assignment_id, submission.student_id],
    ),
    pool.query(
      `SELECT sc.id, sc.submission_id, sc.body, sc.created_at, u.id AS author_id, u.full_name AS author_name, u.role AS author_role, s.attempt_no
         FROM submission_comments sc
         JOIN users u ON u.id = sc.author_id
         JOIN assignment_submissions s ON s.id = sc.submission_id
        WHERE s.assignment_id = $1 AND s.student_id = $2 ORDER BY sc.created_at ASC`,
      [submission.assignment_id, submission.student_id],
    ),
  ]);
  return { ...submission, attempts: attempts.rows, reviews: reviews.rows, comments: comments.rows };
}

export async function fileForSubmission(id) {
  const { rows } = await pool.query(`SELECT f.* FROM assignment_submissions s JOIN files f ON f.id = s.file_id WHERE s.id = $1`, [id]);
  return rows[0] || null;
}
