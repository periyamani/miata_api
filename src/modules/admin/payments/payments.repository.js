import { pool } from '../../../config/db.js';
import { PAYMENT_COLUMNS, PAYMENT_FROM } from '../../../repositories/fees.repository.js';
import { limitOffset, orderBy, paged, SqlBuilder } from '../../../utils/sql.js';

const SORTS = { created_at: 'p.created_at', paid_on: 'p.paid_on', amount: 'p.amount', student: 'u.full_name', status: 'p.status' };

const LIST_FROM = `${PAYMENT_FROM}
  JOIN users u ON u.id = e.student_id
  JOIN student_profiles sp ON sp.user_id = u.id`;

const LIST_COLUMNS = `${PAYMENT_COLUMNS},
  u.id AS student_id, u.full_name AS student_name, u.email AS student_email, sp.student_code`;

export async function listPayments({ page, pageSize, search, sort, order, status, courseId, studentId }) {
  const q = new SqlBuilder();
  if (status) q.where(`p.status = ${q.param(status)}`);
  if (courseId) q.where(`e.course_id = ${q.param(courseId)}`);
  if (studentId) q.where(`e.student_id = ${q.param(studentId)}`);
  q.search(search, ['u.full_name', 'u.email', 'sp.student_code', 'p.reference']);
  return paged(
    pool,
    `SELECT ${LIST_COLUMNS}, count(*) OVER () AS total_count
       ${LIST_FROM} ${q.whereClause()}
       ${orderBy(sort, order, SORTS, 'created_at')}, p.id DESC
       ${limitOffset(q, { page, pageSize })}`,
    q.params,
  );
}

export async function findPayment(id, db = pool) {
  const { rows } = await db.query(
    `SELECT ${LIST_COLUMNS}, u.is_active AS student_active, p.submitted_by, p.proof_file_id
       ${LIST_FROM} WHERE p.id = $1`,
    [id],
  );
  return rows[0] || null;
}

/** Counts and amounts by status, and what was approved this calendar month. */
export async function paymentStats() {
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE status = 'pending') AS pending_count,
            COALESCE(sum(amount) FILTER (WHERE status = 'pending'), 0) AS pending_amount,
            count(*) FILTER (WHERE status = 'approved') AS approved_count,
            COALESCE(sum(amount) FILTER (WHERE status = 'approved'), 0) AS approved_amount,
            COALESCE(sum(amount) FILTER (WHERE status = 'approved' AND reviewed_at >= date_trunc('month', now())), 0) AS approved_this_month,
            count(*) FILTER (WHERE status = 'rejected') AS rejected_count,
            (SELECT COALESCE(sum(balance), 0) FROM enrolment_fees WHERE balance > 0) AS outstanding
       FROM fee_payments`,
  );
  return rows[0];
}
