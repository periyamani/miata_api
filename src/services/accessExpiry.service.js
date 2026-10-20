import { env } from '../config/env.js';
import { withTransaction } from '../config/db.js';
import { formatDay } from '../utils/dates.js';
import { logger } from '../utils/logger.js';
import { logActivity } from './activity.service.js';
import { notifyRole } from './notification.service.js';
import { revokeAllRefreshTokens } from './token.service.js';

/**
 * Course access periods. Each enrolment runs from its start date to its end date (start + course duration, migration 013);
 * a student's access ends on the latest end date of their enrolments (`student_access` view). The day after, the account
 * is deactivated and every session ends. Students who are not enrolled, or have a course without a duration, never expire.
 *
 * `student_profiles.access_expired_on` records the end date already dealt with: set when the account is deactivated, or
 * when an admin reactivates it although access has ended (acknowledgeEndedAccess). The account is then not deactivated
 * again until a later end date passes. Changing an enrolment's dates clears it. "Today" is the day in APP_TIMEZONE.
 */

/**
 * Deactivate every student whose access has ended (or only `studentId`). Runs in the caller's transaction when `db` is
 * given. Returns the deactivated students: [{ id, full_name, access_ends_on }].
 */
export async function expireStudentAccounts({ studentId = null, db = null } = {}) {
  const run = async (client) => {
    // The row lock taken by UPDATE re-checks is_active, so two concurrent runs never deactivate (and log) twice.
    const { rows } = await client.query(
      `UPDATE users u
          SET is_active = FALSE, deactivated_reason = 'course_expired', token_version = u.token_version + 1
         FROM student_access sa, student_profiles sp
        WHERE sa.student_id = u.id AND sp.user_id = u.id
          AND u.role = 'student' AND u.is_active
          AND sa.access_ends_on < (now() AT TIME ZONE $1)::date
          AND (sp.access_expired_on IS NULL OR sp.access_expired_on < sa.access_ends_on)
          AND ($2::bigint IS NULL OR u.id = $2)
      RETURNING u.id, u.full_name, sa.access_ends_on`,
      [env.timeZone, studentId],
    );
    for (const s of rows) {
      await client.query('UPDATE student_profiles SET access_expired_on = $2 WHERE user_id = $1', [s.id, s.access_ends_on]);
      await revokeAllRefreshTokens(s.id, client);
      await logActivity(
        {
          action: 'student.access_expired',
          entityType: 'user',
          entityId: s.id,
          description: `${s.full_name}'s course access ended on ${formatDay(s.access_ends_on)}: account deactivated automatically`,
          metadata: { accessEndsOn: s.access_ends_on },
        },
        client,
      );
    }
    if (rows.length) {
      await notifyRole(
        'admin',
        {
          type: 'access_expired',
          title: rows.length === 1 ? `Course access ended: ${rows[0].full_name}` : `Course access ended for ${rows.length} students`,
          body: 'Deactivated automatically. Extend the course end date and reactivate the account to give more time.',
          link: rows.length === 1 ? `/admin/students/${rows[0].id}` : '/admin/students?status=inactive',
        },
        client,
      );
    }
    return rows;
  };
  return db ? run(db) : withTransaction(run);
}

/**
 * An admin reactivated the student although their access has ended: keep them active until a later end date passes.
 * (Changing an enrolment's dates clears this, so the new dates apply from scratch.)
 */
export async function acknowledgeEndedAccess(studentId, db) {
  await db.query(
    `UPDATE student_profiles sp SET access_expired_on = sa.access_ends_on
       FROM student_access sa
      WHERE sp.user_id = $1 AND sa.student_id = sp.user_id AND sa.access_ends_on < (now() AT TIME ZONE $2)::date`,
    [studentId, env.timeZone],
  );
}

/** Check now and then every ACCESS_EXPIRY_CHECK_MINUTES. Returns a function that stops the job. */
export function startAccessExpiryJob({ intervalMinutes = env.accessExpiryCheckMinutes } = {}) {
  const tick = async () => {
    try {
      const expired = await expireStudentAccounts();
      if (expired.length) {
        logger.info(`Course access ended: ${expired.length} student account(s) deactivated`, { studentIds: expired.map((s) => s.id) });
      }
    } catch (err) {
      logger.error('Course access expiry check failed', { error: err.message });
    }
  };
  tick();
  const timer = setInterval(tick, intervalMinutes * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
