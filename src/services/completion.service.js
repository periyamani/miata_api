import { withTransaction } from '../config/db.js';
import { logger } from '../utils/logger.js';
import { logActivity } from './activity.service.js';
import { notifyRole, notifyUsers } from './notification.service.js';
import { createPasswordResetToken, sendPasswordResetEmail } from './passwordReset.service.js';
import { summarizeProgress } from './progress.service.js';
import { getCompletionPolicy } from './settings.service.js';
import { endAllSessions } from './token.service.js';

/**
 * Check whether a student has satisfied the completion policy for a course and, if so, complete it.
 *
 * Called only by the backend (after a video crosses the watch threshold or a professor marks a
 * submission Completed). There is deliberately no endpoint that completes a course on request.
 *
 * On completion, in one transaction: enrolment → completed, activity log, notifications, then per
 * policy: forced password reset and/or invalidation of every session of the student.
 */
export async function evaluateCourseCompletion(studentId, courseId, { actorId = null, ip = null } = {}) {
  const policy = await getCompletionPolicy();

  const outcome = await withTransaction(async (db) => {
    const { rows: enrolments } = await db.query(
      'SELECT id, status FROM course_enrolments WHERE student_id = $1 AND course_id = $2 FOR UPDATE',
      [studentId, courseId],
    );
    const enrolment = enrolments[0];
    if (!enrolment || enrolment.status !== 'active') return { completed: false };

    const { rows: countRows } = await db.query('SELECT * FROM enrolment_progress WHERE enrolment_id = $1', [enrolment.id]);
    const progress = summarizeProgress(countRows[0], policy, enrolment.status);
    if (!progress.criteria_met) return { completed: false, progress };

    await db.query(`UPDATE course_enrolments SET status = 'completed', completed_at = now() WHERE id = $1`, [enrolment.id]);

    const { rows: infoRows } = await db.query(
      `SELECT u.id, u.full_name, u.email, c.title AS course_title, r.agent_id
         FROM users u
         JOIN courses c ON c.id = $2
         LEFT JOIN agent_referrals r ON r.student_id = u.id
        WHERE u.id = $1`,
      [studentId, courseId],
    );
    const info = infoRows[0];

    await logActivity(
      {
        actorId: actorId ?? studentId,
        action: 'course.completed',
        entityType: 'course',
        entityId: courseId,
        description: `${info.full_name} completed ${info.course_title}`,
        metadata: { studentId, enrolmentId: enrolment.id, progress, policy },
        ip,
      },
      db,
    );
    await notifyUsers(
      [studentId],
      {
        type: 'course_completed',
        title: `Course completed: ${info.course_title}`,
        body: 'Congratulations! Your completion has been recorded.',
        link: '/student/completion',
      },
      db,
    );
    if (info.agent_id) {
      await notifyUsers(
        [info.agent_id],
        { type: 'referral_completed', title: `${info.full_name} completed ${info.course_title}`, link: '/agent/students' },
        db,
      );
    }
    await notifyRole(
      'admin',
      { type: 'course_completed', title: `${info.full_name} completed ${info.course_title}`, link: `/admin/students/${studentId}` },
      db,
    );

    const resetRequired = policy.passwordResetOnCompletion !== 'none';
    if (resetRequired) {
      await db.query(`UPDATE users SET must_reset_password = TRUE, password_reset_reason = 'course_completed' WHERE id = $1`, [studentId]);
    }
    // A pending password reset blocks API access anyway, so the session always ends in that case.
    const sessionEnded = policy.logoutOnCompletion || resetRequired;
    if (sessionEnded) await endAllSessions(studentId, db);

    const resetToken = policy.passwordResetOnCompletion === 'email_link' ? await createPasswordResetToken(studentId, 'reset', db) : null;

    return { completed: true, sessionEnded, resetRequired, info, resetToken };
  });

  if (outcome.resetToken) {
    // Outside the transaction: an email failure must not undo the completion. The student can still
    // sign in with their current password and will be taken to the mandatory reset screen.
    const result = await sendPasswordResetEmail(outcome.info, outcome.resetToken, { reason: 'course_completed' });
    if (result.status !== 'sent') logger.warn('Completion reset email not delivered', { studentId, status: result.status });
  }

  return {
    completed: outcome.completed,
    sessionEnded: outcome.sessionEnded ?? false,
    resetRequired: outcome.resetRequired ?? false,
  };
}
