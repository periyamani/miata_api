import { pool } from '../config/db.js';
import { SqlBuilder } from '../utils/sql.js';
import { assignmentAudiencePredicate, studentAssignmentPredicate } from './scope.js';

/**
 * Submission counts for an assignment aliased `a` (each student's latest attempt only), over the students the
 * assignment is assigned to. `scope(studentIdExpr)` narrows the students counted (a professor's students, one batch).
 */
export function submissionCounts(scope = null) {
  const narrow = (studentIdExpr) => (scope ? ` AND ${scope(studentIdExpr)}` : '');
  return `
  (SELECT count(*) FROM course_enrolments e WHERE e.course_id = a.course_id AND e.status IN ('active', 'completed')
     AND ${assignmentAudiencePredicate('a', 'e.student_id')}${narrow('e.student_id')}) AS student_count,
  (SELECT count(*) FROM assignment_submissions s WHERE s.assignment_id = a.id AND s.attempt_no =
     (SELECT max(attempt_no) FROM assignment_submissions s2 WHERE s2.assignment_id = s.assignment_id AND s2.student_id = s.student_id)${narrow('s.student_id')}) AS submitted_count,
  (SELECT count(*) FROM assignment_submissions s WHERE s.assignment_id = a.id AND s.status IN ('submitted', 'in_review')${narrow('s.student_id')}) AS pending_count,
  (SELECT count(*) FROM assignment_submissions s WHERE s.assignment_id = a.id AND s.status = 'rework'
     AND NOT EXISTS (SELECT 1 FROM assignment_submissions s3 WHERE s3.assignment_id = s.assignment_id
                       AND s3.student_id = s.student_id AND s3.attempt_no > s.attempt_no)${narrow('s.student_id')}) AS rework_count,
  (SELECT count(*) FROM assignment_submissions s WHERE s.assignment_id = a.id AND s.status = 'completed'${narrow('s.student_id')}) AS completed_count`;
}

export const SUBMISSION_COUNTS = submissionCounts();

/** Who an assignment aliased `a` is for: its batch and, when students were selected, how many and who. */
export const AUDIENCE_COLUMNS = `
  ab.name AS batch_name, ab.code AS batch_code,
  (SELECT count(*) FROM assignment_students x WHERE x.assignment_id = a.id) AS recipient_count,
  COALESCE((SELECT json_agg(json_build_object('id', ru.id, 'full_name', ru.full_name) ORDER BY ru.full_name)
              FROM assignment_students x JOIN users ru ON ru.id = x.student_id WHERE x.assignment_id = a.id), '[]') AS recipients`;
export const AUDIENCE_JOIN = 'LEFT JOIN batches ab ON ab.id = a.batch_id';

// ─── Writes (professor portal; the service checks teaching scope first) ──

export async function insertAssignment(data, attachmentFileId, userId, db) {
  const { rows } = await db.query(
    `INSERT INTO assignments (course_id, module_id, batch_id, title, instructions, due_at, is_required, is_published, attachment_file_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [
      data.courseId,
      data.moduleId,
      data.batchId,
      data.title,
      data.instructions,
      data.dueAt,
      data.isRequired,
      data.isPublished,
      attachmentFileId,
      userId,
    ],
  );
  return rows[0];
}

export async function updateAssignment(id, data, attachmentFileId, db) {
  const { rows } = await db.query(
    `UPDATE assignments SET course_id = $2, module_id = $3, batch_id = $4, title = $5, instructions = $6, due_at = $7,
            is_required = $8, is_published = $9, attachment_file_id = $10
      WHERE id = $1 RETURNING *`,
    [
      id,
      data.courseId,
      data.moduleId,
      data.batchId,
      data.title,
      data.instructions,
      data.dueAt,
      data.isRequired,
      data.isPublished,
      attachmentFileId,
    ],
  );
  return rows[0] || null;
}

/** Replace the selected students of a batch assignment (an empty list means the whole batch). */
export async function replaceRecipients(assignmentId, studentIds, db) {
  await db.query('DELETE FROM assignment_students WHERE assignment_id = $1', [assignmentId]);
  if (studentIds.length) {
    await db.query(`INSERT INTO assignment_students (assignment_id, student_id) SELECT $1, unnest($2::bigint[]) ON CONFLICT DO NOTHING`, [
      assignmentId,
      studentIds,
    ]);
  }
}

/** Actively enrolled students an assignment is assigned to (who is notified when it is published). */
export async function audienceStudentIds(assignmentId, db = pool) {
  const { rows } = await db.query(
    `SELECT e.student_id FROM assignments a
       JOIN course_enrolments e ON e.course_id = a.course_id AND e.status = 'active'
      WHERE a.id = $1 AND ${assignmentAudiencePredicate('a', 'e.student_id')}`,
    [assignmentId],
  );
  return rows.map((r) => r.student_id);
}

export async function hasSubmissions(id, db = pool) {
  const { rowCount } = await db.query('SELECT 1 FROM assignment_submissions WHERE assignment_id = $1 LIMIT 1', [id]);
  return rowCount > 0;
}

export async function deleteAssignment(id, db) {
  await db.query('DELETE FROM assignments WHERE id = $1', [id]);
}

/** Student-facing status of an assignment, derived from the latest attempt. */
export const STUDENT_ASSIGNMENT_STATUS = `COALESCE(ls.status, 'pending')`;

/**
 * Published assignments assigned to the student in their enrolled courses, with the latest submission attempt.
 * Used by the student portal and by the admin student profile, so both show exactly the same work.
 */
export async function studentAssignments(studentId, { courseId, status, limit, onlyActiveCourses = false } = {}) {
  const q = new SqlBuilder();
  const sid = q.param(studentId);
  q.where(`e.student_id = ${sid}`);
  q.where(`e.status IN ('active', 'completed')`);
  q.where(studentAssignmentPredicate('a', sid));
  if (onlyActiveCourses) q.where('c.is_active');
  if (courseId) q.where(`a.course_id = ${q.param(courseId)}`);
  if (status) q.where(`${STUDENT_ASSIGNMENT_STATUS} = ${q.param(status)}`);
  const limitSql = limit ? `LIMIT ${q.param(limit)}` : '';
  const { rows } = await pool.query(
    `SELECT a.id, a.title, a.instructions, a.due_at, a.is_required, a.course_id, a.module_id, a.batch_id,
            c.title AS course_title, m.title AS module_title, ab.name AS batch_name,
            EXISTS (SELECT 1 FROM assignment_students x WHERE x.assignment_id = a.id) AS for_selected_students,
            ${STUDENT_ASSIGNMENT_STATUS} AS status,
            ls.id AS submission_id, ls.attempt_no, ls.submitted_at, ls.reviewed_at,
            (a.due_at IS NOT NULL AND a.due_at < now() AND ls.id IS NULL) AS is_overdue
       FROM course_enrolments e
       JOIN assignments a ON a.course_id = e.course_id AND a.is_published
       JOIN courses c ON c.id = a.course_id
       LEFT JOIN modules m ON m.id = a.module_id
       ${AUDIENCE_JOIN}
       LEFT JOIN LATERAL (
         SELECT s.id, s.status, s.attempt_no, s.submitted_at, s.reviewed_at
           FROM assignment_submissions s
          WHERE s.assignment_id = a.id AND s.student_id = e.student_id
          ORDER BY s.attempt_no DESC LIMIT 1
       ) ls ON TRUE
      ${q.whereClause()}
      ORDER BY (${STUDENT_ASSIGNMENT_STATUS} IN ('pending', 'rework')) DESC, a.due_at ASC NULLS LAST, a.id
      ${limitSql}`,
    q.params,
  );
  return rows;
}
