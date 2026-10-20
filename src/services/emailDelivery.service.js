import { z } from 'zod';
import { pool } from '../config/db.js';
import { logger } from '../utils/logger.js';
import { sendEmail } from './email.service.js';

// Person-to-person e-mails (account set-up, meeting invitations) go through this outbox:
//   1. queueEmails() inside the transaction that causes them — one row per recipient in email_deliveries. A dedupe key that
//      already exists is skipped, so retries, double clicks and concurrent saves never send the same notification twice.
//   2. sendQueued() after the transaction commits — each e-mail has exactly one recipient (students never see each
//      other's addresses) and its real outcome (sent / failed / skipped) is stored on the row.
//   3. claimForRetry() lets a user resend failed or skipped e-mails; rows stuck in "pending" (e.g. the API stopped while
//      sending) can be claimed again after STUCK_MINUTES.

const STUCK_MINUTES = 5;
const CONCURRENCY = 4;
const validAddress = z.email().max(254);

/**
 * items: [{ dedupeKey, kind, user: { id, email }, meetingId?, message: { subject, text, html } }].
 * Returns the items that were newly queued (with their delivery `id`), in the given order.
 */
export async function queueEmails(items, db) {
  if (!items.length) return [];
  const { rows } = await db.query(
    `INSERT INTO email_deliveries (dedupe_key, kind, user_id, meeting_id, recipient, subject)
     SELECT * FROM unnest($1::text[], $2::text[], $3::bigint[], $4::bigint[], $5::text[], $6::text[])
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id, dedupe_key`,
    [
      items.map((i) => i.dedupeKey),
      items.map((i) => i.kind),
      items.map((i) => i.user.id),
      items.map((i) => i.meetingId ?? null),
      items.map((i) => i.user.email),
      items.map((i) => i.message.subject),
    ],
  );
  const ids = new Map(rows.map((r) => [r.dedupe_key, r.id]));
  return items.filter((i) => ids.has(i.dedupeKey)).map((i) => ({ ...i, id: ids.get(i.dedupeKey) }));
}

/** Send one queued e-mail to its single recipient and store the outcome. Never throws; resolves to { status, error? }. */
export async function sendOne({ id, user, message }) {
  const result = validAddress.safeParse(user.email).success
    ? await sendEmail({ to: user.email, ...message })
    : { status: 'failed', error: 'Invalid e-mail address' };
  try {
    await pool.query(
      `UPDATE email_deliveries
          SET status = $2, error = $3, recipient = $4, subject = $5, attempts = attempts + 1,
              sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END
        WHERE id = $1`,
      [id, result.status, result.error ?? null, user.email, message.subject],
    );
  } catch (err) {
    // The row stays "pending" and can be claimed again by a retry later.
    logger.error('Could not record an e-mail delivery', { deliveryId: id, error: err.message });
  }
  return result;
}

/** Send queued e-mails a few at a time. Never throws; resolves to { sent, failed, skipped }. */
export async function sendQueued(queued) {
  const summary = { sent: 0, failed: 0, skipped: 0 };
  const queue = [...queued];
  const worker = async () => {
    while (queue.length) summary[(await sendOne(queue.shift())).status] += 1;
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return summary;
}

/**
 * Claim deliveries for another attempt: failed, skipped, or pending for longer than STUCK_MINUTES. The status check in
 * the UPDATE means two concurrent retries can never claim (and send) the same row twice. Returns the claimed rows.
 */
export async function claimForRetry(ids, db = pool) {
  if (!ids.length) return [];
  const { rows } = await db.query(
    `UPDATE email_deliveries SET status = 'pending', error = NULL
      WHERE id = ANY($1::bigint[])
        AND (status IN ('failed', 'skipped') OR (status = 'pending' AND updated_at < now() - make_interval(mins => $2)))
      RETURNING id, kind, user_id, meeting_id`,
    [ids, STUCK_MINUTES],
  );
  return rows;
}

/** SQL condition (on alias `d`) matching what claimForRetry would claim. */
export const RETRYABLE_SQL = `(d.status IN ('failed', 'skipped') OR (d.status = 'pending' AND d.updated_at < now() - interval '${STUCK_MINUTES} minutes'))`;
