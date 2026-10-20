import { pool, withTransaction } from '../../../config/db.js';
import { AppError, notFound } from '../../../utils/AppError.js';
import { formatMoney } from '../../../utils/money.js';
import { logActivity } from '../../../services/activity.service.js';
import { notifyUsers } from '../../../services/notification.service.js';
import { getFeeSettings } from '../../../services/settings.service.js';
import { paymentProof } from '../../../repositories/fees.repository.js';
import * as repo from './payments.repository.js';

export async function listPayments(query) {
  const [result, { currency }] = await Promise.all([repo.listPayments(query), getFeeSettings()]);
  return { ...result, currency };
}

export async function stats() {
  const [counts, { currency }] = await Promise.all([repo.paymentStats(), getFeeSettings()]);
  return { ...counts, currency };
}

/** The payment, who sent it, and the fee position of that enrolment (payable, paid, pending, balance). */
export async function getPayment(id) {
  const payment = await repo.findPayment(id);
  if (!payment) throw notFound('Payment');
  const [{ rows }, { currency }] = await Promise.all([
    pool.query('SELECT * FROM enrolment_fees WHERE enrolment_id = $1', [payment.enrolment_id]),
    getFeeSettings(),
  ]);
  const { submitted_by: _by, proof_file_id: _file, ...safe } = payment;
  return { ...safe, fees: rows[0], currency };
}

export async function proofFile(id) {
  const file = await paymentProof(id);
  if (!file) throw notFound('Payment');
  return file;
}

const ACTION = { approved: 'payment.approved', rejected: 'payment.rejected', pending: 'payment.reopened' };

/**
 * Verify a payment: approve it (it then counts as paid and lowers the balance), reject it with a reason the student sees,
 * or set it back to pending to correct a mistake. Every change is logged with the previous status, and the student is
 * notified.
 */
export async function setStatus(id, { status, note }, actor) {
  if (status === 'rejected' && !note) {
    throw new AppError(422, 'VALIDATION_ERROR', 'Please correct the highlighted fields', {
      note: 'Give the reason for rejecting the payment (the student sees it)',
    });
  }
  await withTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT p.*, e.student_id, c.title AS course_title, u.full_name AS student_name
         FROM fee_payments p
         JOIN course_enrolments e ON e.id = p.enrolment_id
         JOIN courses c ON c.id = e.course_id
         JOIN users u ON u.id = e.student_id
        WHERE p.id = $1 FOR UPDATE OF p`,
      [id],
    );
    const payment = rows[0];
    if (!payment) throw notFound('Payment');
    if (payment.status === status && (payment.review_note ?? null) === note) return;

    await db.query(
      `UPDATE fee_payments
          SET status = $2::text, review_note = $3,
              reviewed_by = CASE WHEN $2::text = 'pending' THEN NULL ELSE $4::bigint END,
              reviewed_at = CASE WHEN $2::text = 'pending' THEN NULL ELSE now() END
        WHERE id = $1`,
      [id, status, note, actor.id],
    );
    const { currency } = await getFeeSettings(db);
    const amount = formatMoney(payment.amount, currency);
    await logActivity(
      {
        actorId: actor.id,
        action: ACTION[status],
        entityType: 'payment',
        entityId: id,
        description: `Payment of ${amount} from ${payment.student_name} for ${payment.course_title} ${
          status === 'pending' ? 'set back to pending' : status
        }`,
        metadata: {
          studentId: payment.student_id,
          enrolmentId: payment.enrolment_id,
          amount: payment.amount,
          previousStatus: payment.status,
          note,
        },
      },
      db,
    );

    const { rows: fees } = await db.query('SELECT balance FROM enrolment_fees WHERE enrolment_id = $1', [payment.enrolment_id]);
    const balance = formatMoney(fees[0].balance, currency);
    const message = {
      approved: { title: `Payment of ${amount} approved`, body: `${payment.course_title}: balance now ${balance}.` },
      rejected: { title: `Payment of ${amount} was not accepted`, body: note },
      pending: { title: `Payment of ${amount} is being checked again`, body: `${payment.course_title}: balance now ${balance}.` },
    }[status];
    await notifyUsers([payment.student_id], { type: `payment_${status}`, ...message, link: '/student/fees' }, db);
  });
  return getPayment(id);
}
