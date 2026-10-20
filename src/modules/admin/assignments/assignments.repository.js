import { pool } from '../../../config/db.js';
import { limitOffset, orderBy, paged, SqlBuilder } from '../../../utils/sql.js';
import { AUDIENCE_COLUMNS, AUDIENCE_JOIN, SUBMISSION_COUNTS, submissionCounts } from '../../../repositories/assignments.repository.js';
import { studentInBatchPredicate } from '../../../repositories/scope.js';

// Read-only: assignments are created and edited by professors (see modules/professor).

const SORTS = { title: 'a.title', due_at: 'a.due_at', created_at: 'a.created_at' };

/**
 * All assignments, or with `batchId` the batch's work (set for the batch, or course-wide in its courses) with the
 * submission counts of that batch's students only.
 */
export async function listAssignments({ page, pageSize, search, sort, order, courseId, moduleId, batchId, published }) {
  const q = new SqlBuilder();
  const b = batchId ? q.param(batchId) : null;
  q.search(search, ['a.title', 'c.title']);
  if (courseId) q.where(`a.course_id = ${q.param(courseId)}`);
  if (moduleId) q.where(`a.module_id = ${q.param(moduleId)}`);
  if (published !== undefined) q.where(`a.is_published = ${q.param(published)}`);
  if (b) {
    q.where(`(a.batch_id = ${b} OR (a.batch_id IS NULL AND EXISTS (
               SELECT 1 FROM batch_courses bc WHERE bc.batch_id = ${b} AND bc.course_id = a.course_id)))`);
  }
  const counts = b ? submissionCounts((studentIdExpr) => studentInBatchPredicate(studentIdExpr, b)) : SUBMISSION_COUNTS;
  return paged(
    pool,
    `SELECT a.*, c.title AS course_title, m.title AS module_title, f.original_name AS attachment_name,
            cb.full_name AS created_by_name, ${AUDIENCE_COLUMNS}, ${counts}, count(*) OVER () AS total_count
       FROM assignments a
       JOIN courses c ON c.id = a.course_id
       LEFT JOIN modules m ON m.id = a.module_id
       LEFT JOIN files f ON f.id = a.attachment_file_id
       LEFT JOIN users cb ON cb.id = a.created_by
       ${AUDIENCE_JOIN}
       ${q.whereClause()}
       ${orderBy(sort, order, SORTS, 'created_at')}
       ${limitOffset(q, { page, pageSize })}`,
    q.params,
  );
}

export async function findAssignment(id) {
  const { rows } = await pool.query(
    `SELECT a.*, c.title AS course_title, m.title AS module_title,
            f.original_name AS attachment_name, f.size_bytes AS attachment_size,
            cb.full_name AS created_by_name, ${AUDIENCE_COLUMNS}, ${SUBMISSION_COUNTS}
       FROM assignments a
       JOIN courses c ON c.id = a.course_id
       LEFT JOIN modules m ON m.id = a.module_id
       LEFT JOIN files f ON f.id = a.attachment_file_id
       LEFT JOIN users cb ON cb.id = a.created_by
       ${AUDIENCE_JOIN}
      WHERE a.id = $1`,
    [id],
  );
  return rows[0] || null;
}

export async function attachmentFile(assignmentId) {
  const { rows } = await pool.query('SELECT f.* FROM assignments a JOIN files f ON f.id = a.attachment_file_id WHERE a.id = $1', [
    assignmentId,
  ]);
  return rows[0] || null;
}
