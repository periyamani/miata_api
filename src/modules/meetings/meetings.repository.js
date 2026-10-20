import { pool } from '../../config/db.js';
import { professorBatchPredicate, studentMeetingPredicate } from '../../repositories/scope.js';
import { RETRYABLE_SQL } from '../../services/emailDelivery.service.js';
import { limitOffset, orderBy, paged, SqlBuilder } from '../../utils/sql.js';

const ENDS_AT = 'm.starts_at + make_interval(mins => m.duration_minutes)';
const COLUMNS = `m.*, ${ENDS_AT} AS ends_at, b.name AS batch_name, b.code AS batch_code, p.full_name AS professor_name`;
const FROM = 'FROM meetings m JOIN batches b ON b.id = m.batch_id JOIN users p ON p.id = m.professor_id';

// Who a meeting is for right now: active student accounts in its audience (scope.js). Used for e-mails and counts.
const AUDIENCE = (meeting) => `u.role = 'student' AND u.is_active AND ${studentMeetingPredicate(meeting, 'u.id')}`;
const RECIPIENT_COUNT = `(SELECT count(*) FROM users u WHERE ${AUDIENCE('m')}) AS recipient_count`;
// Status of the latest e-mail each person received about the meeting, counted.
const EMAIL_COUNTS = `(SELECT json_build_object(
    'sent', count(*) FILTER (WHERE l.status = 'sent'), 'pending', count(*) FILTER (WHERE l.status = 'pending'),
    'failed', count(*) FILTER (WHERE l.status = 'failed'), 'skipped', count(*) FILTER (WHERE l.status = 'skipped'))
   FROM (SELECT DISTINCT ON (d.user_id) d.status FROM email_deliveries d
          WHERE d.meeting_id = m.id ORDER BY d.user_id, d.id DESC) l) AS emails`;

const WHEN = {
  upcoming: `m.status = 'scheduled' AND ${ENDS_AT} > now()`,
  past: `m.status = 'scheduled' AND ${ENDS_AT} <= now()`,
  cancelled: `m.status = 'cancelled'`,
};
const SORTS = { starts_at: 'm.starts_at', title: 'm.title', created_at: 'm.created_at' };

/** Meetings with audience size and e-mail counts. `scope.professorId` limits the list to one organiser. */
export async function listMeetings({ page, pageSize, search, sort, order, when, batchId, professorId }, scope = {}) {
  const q = new SqlBuilder();
  if (scope.professorId) q.where(`m.professor_id = ${q.param(scope.professorId)}`);
  if (professorId) q.where(`m.professor_id = ${q.param(professorId)}`);
  if (batchId) q.where(`m.batch_id = ${q.param(batchId)}`);
  if (when) q.where(WHEN[when]);
  q.search(search, ['m.title', 'b.name', 'b.code', 'p.full_name']);
  return paged(
    pool,
    `SELECT ${COLUMNS}, ${RECIPIENT_COUNT}, ${EMAIL_COUNTS}, count(*) OVER () AS total_count
       ${FROM} ${q.whereClause()}
       ${orderBy(sort, order, SORTS, 'starts_at')}
       ${limitOffset(q, { page, pageSize })}`,
    q.params,
  );
}

/** One meeting; with `professorId` only if that professor organised it. `lock` takes a row lock (inside a transaction). */
export async function findMeeting(meetingId, { professorId = null, lock = false } = {}, db = pool) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS}, ${RECIPIENT_COUNT}, ${EMAIL_COUNTS} ${FROM}
      WHERE m.id = $1 AND ($2::bigint IS NULL OR m.professor_id = $2) ${lock ? 'FOR UPDATE OF m' : ''}`,
    [meetingId, professorId],
  );
  return rows[0] || null;
}

export async function participantIds(meetingId, db = pool) {
  const { rows } = await db.query('SELECT student_id FROM meeting_participants WHERE meeting_id = $1 ORDER BY student_id', [meetingId]);
  return rows.map((r) => r.student_id);
}

export async function replaceParticipants(meetingId, studentIds, db) {
  await db.query('DELETE FROM meeting_participants WHERE meeting_id = $1', [meetingId]);
  if (studentIds.length) {
    await db.query('INSERT INTO meeting_participants (meeting_id, student_id) SELECT $1, unnest($2::bigint[])', [meetingId, studentIds]);
  }
}

/** The students a meeting is for right now — exactly who is e-mailed and who can see it. */
export async function recipients(meetingId, db = pool) {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.full_name FROM meetings m CROSS JOIN users u
      WHERE m.id = $1 AND ${AUDIENCE('m')} ORDER BY u.full_name, u.id`,
    [meetingId],
  );
  return rows;
}

/** Recipients with the latest e-mail each received about the meeting (for the organiser and admins). */
export async function recipientsWithEmail(meetingId) {
  const { rows } = await pool.query(
    `SELECT u.id AS student_id, u.full_name, u.email, sp.student_code,
            d.kind AS email_kind, d.status AS email_status, d.error AS email_error, d.sent_at AS email_sent_at,
            COALESCE(${RETRYABLE_SQL}, FALSE) AS email_retryable
       FROM meetings m CROSS JOIN users u
       LEFT JOIN student_profiles sp ON sp.user_id = u.id
       LEFT JOIN LATERAL (SELECT * FROM email_deliveries d WHERE d.meeting_id = m.id AND d.user_id = u.id ORDER BY d.id DESC LIMIT 1) d ON TRUE
      WHERE m.id = $1 AND ${AUDIENCE('m')}
      ORDER BY u.full_name, u.id`,
    [meetingId],
  );
  return rows;
}

/**
 * Latest e-mail per person that can be retried (failed, skipped or stuck). Invitations and updates are only resent to
 * people still in the audience of a meeting that is still scheduled; cancellation notices to anyone still active.
 */
export async function retryableDeliveries(meetingId) {
  const { rows } = await pool.query(
    `SELECT d.id FROM (SELECT DISTINCT ON (user_id) * FROM email_deliveries
                        WHERE meeting_id = $1 AND user_id IS NOT NULL ORDER BY user_id, id DESC) d
       JOIN meetings m ON m.id = d.meeting_id
       JOIN users u ON u.id = d.user_id AND u.is_active
      WHERE ${RETRYABLE_SQL}
        AND (d.kind = 'meeting_cancelled' OR (m.status = 'scheduled' AND ${AUDIENCE('m')}))`,
    [meetingId],
  );
  return rows.map((r) => r.id);
}

export async function usersByIds(ids, db = pool) {
  const { rows } = await db.query('SELECT id, email, full_name FROM users WHERE id = ANY($1::bigint[])', [ids]);
  return new Map(rows.map((u) => [u.id, u]));
}

/** Whether the batch exists and is active, and whether the professor is assigned to it. */
export async function batchScope(professorId, batchId, db = pool) {
  const { rows } = await db.query(
    `SELECT b.is_active, ${professorBatchPredicate('b.id', '$2')} AS teaches FROM batches b WHERE b.id = $1`,
    [batchId, professorId],
  );
  return rows[0] || null;
}

/** Of `studentIds`, those who are not active students of the batch. */
export async function outsideBatch(batchId, studentIds, db = pool) {
  const { rows } = await db.query(
    `SELECT x.id FROM unnest($2::bigint[]) AS x(id)
      WHERE NOT EXISTS (SELECT 1 FROM batch_students bs JOIN users u ON u.id = bs.student_id
                         WHERE bs.batch_id = $1 AND bs.student_id = x.id AND u.is_active)`,
    [batchId, studentIds],
  );
  return rows.map((r) => r.id);
}

/** The batch's active students (for choosing selected students). */
export async function batchStudents(batchId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.full_name, sp.student_code
       FROM batch_students bs JOIN users u ON u.id = bs.student_id LEFT JOIN student_profiles sp ON sp.user_id = u.id
      WHERE bs.batch_id = $1 AND u.is_active
      ORDER BY u.full_name, u.id`,
    [batchId],
  );
  return rows;
}

export async function insertMeeting(data, professorId, db) {
  const { rows } = await db.query(
    `INSERT INTO meetings (batch_id, professor_id, title, description, platform, meeting_url, starts_at, duration_minutes, audience)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      data.batchId,
      professorId,
      data.title,
      data.description,
      data.platform,
      data.meetingUrl,
      data.startsAt,
      data.durationMinutes,
      data.audience,
    ],
  );
  return rows[0].id;
}

export async function updateMeeting(meetingId, data, db) {
  await db.query(
    `UPDATE meetings SET batch_id = $2, title = $3, description = $4, platform = $5, meeting_url = $6, starts_at = $7,
            duration_minutes = $8, audience = $9, revision = revision + 1
      WHERE id = $1`,
    [
      meetingId,
      data.batchId,
      data.title,
      data.description,
      data.platform,
      data.meetingUrl,
      data.startsAt,
      data.durationMinutes,
      data.audience,
    ],
  );
}

export async function cancelMeeting(meetingId, reason, db) {
  await db.query(
    `UPDATE meetings SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2, revision = revision + 1 WHERE id = $1`,
    [meetingId, reason],
  );
}

// ─── Student view ───────────────────────────────────────────────────────

/**
 * Meetings the student is in the audience of. upcoming: not yet ended, cancelled ones included so the student knows;
 * past: held meetings. The link is withheld once a meeting is cancelled.
 */
export async function studentMeetings(studentId, { when = 'upcoming', limit = 100 } = {}) {
  const upcoming = when === 'upcoming';
  const { rows } = await pool.query(
    `SELECT m.id, m.title, m.description, m.platform, m.starts_at, m.duration_minutes, ${ENDS_AT} AS ends_at,
            m.status, m.cancel_reason, m.cancelled_at, m.audience,
            CASE WHEN m.status = 'scheduled' THEN m.meeting_url END AS meeting_url,
            b.id AS batch_id, b.name AS batch_name, b.code AS batch_code, p.full_name AS professor_name
       ${FROM}
      WHERE ${studentMeetingPredicate('m', '$1')}
        AND ${upcoming ? `${ENDS_AT} > now()` : `m.status = 'scheduled' AND ${ENDS_AT} <= now()`}
      ORDER BY m.starts_at ${upcoming ? 'ASC' : 'DESC'}
      LIMIT $2`,
    [studentId, limit],
  );
  return rows;
}
