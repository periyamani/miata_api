import { pool } from '../config/db.js';
import { professorSubmissionPredicate } from '../repositories/scope.js';

/** Create the same in-app notification for one or more users. */
export async function notifyUsers(userIds, { type, title, body = null, link = null }, db = pool) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return;
  await db.query(
    `INSERT INTO notifications (user_id, type, title, body, link)
     SELECT unnest($1::bigint[]), $2, $3, $4, $5`,
    [ids, type, title, body, link],
  );
}

export async function notifyRole(role, notification, db = pool) {
  const { rows } = await db.query('SELECT id FROM users WHERE role = $1 AND is_active', [role]);
  await notifyUsers(
    rows.map((r) => r.id),
    notification,
    db,
  );
}

/**
 * Active professors who may review a submission: the student's batch professors for a batched enrolment, otherwise
 * the professors managing the assignment (same rule as the review queue, see repositories/scope.js).
 */
export async function reviewersForSubmission(submissionId, db = pool) {
  const { rows } = await db.query(
    `SELECT p.id FROM users p
       CROSS JOIN assignment_submissions s JOIN assignments a ON a.id = s.assignment_id
      WHERE s.id = $1 AND p.role = 'professor' AND p.is_active AND ${professorSubmissionPredicate('s', 'a', 'p.id')}`,
    [submissionId],
  );
  return rows.map((r) => r.id);
}
