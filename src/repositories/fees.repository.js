import { pool } from '../config/db.js';

// Fees and payments shared by the admin and student APIs. Amounts paid and balances come from the enrolment_fees view
// (migration 013): only approved payments count as paid, so they are never stored and can never go stale.

export const PAYMENT_COLUMNS = `
  p.id, p.enrolment_id, p.amount, p.paid_on, p.method, p.reference, p.notes, p.status, p.review_note,
  p.reviewed_at, p.created_at, p.updated_at,
  e.course_id, c.title AS course_title, c.code AS course_code,
  f.original_name AS proof_name, f.mime_type AS proof_mime_type, f.size_bytes AS proof_size,
  rv.full_name AS reviewed_by_name`;

export const PAYMENT_FROM = `
  FROM fee_payments p
  JOIN course_enrolments e ON e.id = p.enrolment_id
  JOIN courses c ON c.id = e.course_id
  JOIN files f ON f.id = p.proof_file_id
  LEFT JOIN users rv ON rv.id = p.reviewed_by`;

/** Fee, discount, payable, paid, pending and balance for each of the student's enrolments. */
export async function studentFees(studentId, db = pool) {
  const { rows } = await db.query(
    `SELECT ef.enrolment_id, ef.course_id, c.title AS course_title, c.code AS course_code, e.status,
            ef.fee_amount, ef.discount_amount, ef.payable, ef.paid, ef.pending, ef.balance
       FROM enrolment_fees ef
       JOIN course_enrolments e ON e.id = ef.enrolment_id
       JOIN courses c ON c.id = ef.course_id
      WHERE ef.student_id = $1
      ORDER BY e.enrolled_at, e.id`,
    [studentId],
  );
  return rows;
}

const cents = (n) => Math.round(Number(n || 0) * 100);

/** Totals over enrolment fee rows, rounded to cents. */
export function feeTotals(rows) {
  const sum = (key) => rows.reduce((total, r) => total + cents(r[key]), 0) / 100;
  return { payable: sum('payable'), paid: sum('paid'), pending: sum('pending'), balance: sum('balance') };
}

export async function studentPayments(studentId, db = pool) {
  const { rows } = await db.query(
    `SELECT ${PAYMENT_COLUMNS} ${PAYMENT_FROM} WHERE e.student_id = $1 ORDER BY p.created_at DESC, p.id DESC`,
    [studentId],
  );
  return rows;
}

/** The proof file of a payment, optionally only when it belongs to `studentId`. */
export async function paymentProof(paymentId, studentId = null, db = pool) {
  const { rows } = await db.query(
    `SELECT f.* FROM fee_payments p
       JOIN course_enrolments e ON e.id = p.enrolment_id
       JOIN files f ON f.id = p.proof_file_id
      WHERE p.id = $1 AND ($2::bigint IS NULL OR e.student_id = $2)`,
    [paymentId, studentId],
  );
  return rows[0] || null;
}
