import { env } from '../../../config/env.js';
import { withTransaction } from '../../../config/db.js';
import { AppError, notFound } from '../../../utils/AppError.js';
import { formatDay } from '../../../utils/dates.js';
import { formatMoney } from '../../../utils/money.js';
import { expireStudentAccounts } from '../../../services/accessExpiry.service.js';
import { logActivity } from '../../../services/activity.service.js';
import { notifyUsers } from '../../../services/notification.service.js';
import { getFeeSettings } from '../../../services/settings.service.js';

const invalid = (field, message) => new AppError(422, 'VALIDATION_ERROR', message, { [field]: message });

/**
 * Enrol every listed student in every listed course (one course + many students from the course page,
 * or one student + many courses from the student page). Existing enrolments are left untouched.
 */
export const enrol = (input, actor) => withTransaction((db) => enrolWithin(db, input, actor));

/** Same as `enrol`, inside the caller's transaction (e.g. while creating the student account). */
export async function enrolWithin(db, { courseIds, studentIds }, actor) {
  const { rows: courses } = await db.query('SELECT id, title, is_active FROM courses WHERE id = ANY($1::bigint[])', [courseIds]);
  if (courses.length !== new Set(courseIds).size) throw invalid('courseIds', 'One or more courses do not exist');
  const inactive = courses.find((c) => !c.is_active);
  if (inactive) throw invalid('courseIds', `"${inactive.title}" is inactive. Activate it before enrolling students.`);

  const { rows: students } = await db.query(`SELECT id, full_name FROM users WHERE id = ANY($1::bigint[]) AND role = 'student'`, [
    studentIds,
  ]);
  if (students.length !== new Set(studentIds).size) throw invalid('studentIds', 'One or more selected users are not students');

  const { rows: inserted } = await db.query(
    `INSERT INTO course_enrolments (course_id, student_id, enrolled_by)
     SELECT c, s, $3 FROM unnest($1::bigint[]) AS c CROSS JOIN unnest($2::bigint[]) AS s
     ON CONFLICT (course_id, student_id) DO NOTHING
     RETURNING id, course_id, student_id`,
    [courseIds, studentIds, actor.id],
  );

  const courseTitle = Object.fromEntries(courses.map((c) => [c.id, c.title]));
  const studentName = Object.fromEntries(students.map((s) => [s.id, s.full_name]));
  for (const e of inserted) {
    await notifyUsers(
      [e.student_id],
      { type: 'enrolled', title: `You are enrolled in ${courseTitle[e.course_id]}`, link: `/student/courses/${e.course_id}` },
      db,
    );
    await logActivity(
      {
        actorId: actor.id,
        action: 'enrolment.created',
        entityType: 'enrolment',
        entityId: e.id,
        description: `${studentName[e.student_id]} enrolled in ${courseTitle[e.course_id]}`,
        metadata: { courseId: e.course_id, studentId: e.student_id },
      },
      db,
    );
  }
  return { enrolled: inserted.length, alreadyEnrolled: courseIds.length * studentIds.length - inserted.length };
}

async function findEnrolment(id, db) {
  const { rows } = await db.query(
    `SELECT e.*, u.full_name, c.title FROM course_enrolments e
       JOIN users u ON u.id = e.student_id JOIN courses c ON c.id = e.course_id
      WHERE e.id = $1 FOR UPDATE OF e`,
    [id],
  );
  if (!rows[0]) throw notFound('Enrolment');
  return rows[0];
}

/** Admins may suspend/reactivate. "Completed" is only ever set by the completion service. */
export async function updateStatus(id, status, actor) {
  return withTransaction(async (db) => {
    const e = await findEnrolment(id, db);
    if (e.status === 'completed') throw new AppError(409, 'CONFLICT', 'A completed enrolment cannot be changed');
    const { rows } = await db.query('UPDATE course_enrolments SET status = $2 WHERE id = $1 RETURNING *', [id, status]);
    await logActivity(
      {
        actorId: actor.id,
        action: `enrolment.${status}`,
        entityType: 'enrolment',
        entityId: id,
        description: `${e.full_name}'s enrolment in ${e.title} set to ${status}`,
      },
      db,
    );
    return rows[0];
  });
}

export async function remove(id, actor) {
  return withTransaction(async (db) => {
    const e = await findEnrolment(id, db);
    if (e.status === 'completed')
      throw new AppError(409, 'CONFLICT', 'A completed enrolment is part of the student record and cannot be removed');
    const { rowCount: payments } = await db.query('SELECT 1 FROM fee_payments WHERE enrolment_id = $1 LIMIT 1', [id]);
    if (payments) {
      throw new AppError(409, 'CONFLICT', 'Fee payments are recorded for this enrolment, so it cannot be removed. Suspend it instead.');
    }
    await db.query('DELETE FROM course_enrolments WHERE id = $1', [id]);
    await logActivity(
      {
        actorId: actor.id,
        action: 'enrolment.removed',
        entityType: 'enrolment',
        entityId: id,
        description: `${e.full_name} removed from ${e.title}`,
        metadata: { courseId: e.course_id, studentId: e.student_id },
      },
      db,
    );
  });
}

const dayLabel = (d) => (d ? formatDay(d) : 'no end date');

/**
 * Change the student's access period for the course. The new dates apply from scratch and the account is checked at once:
 * it is deactivated when its access has now ended, and reactivated when it had been deactivated only because access ended
 * and the new period runs on.
 */
export async function updateSchedule(id, { startDate, endDate }, actor) {
  if (endDate && endDate < startDate) throw invalid('endDate', 'The end date cannot be before the start date');
  return withTransaction(async (db) => {
    const e = await findEnrolment(id, db);
    await db.query('UPDATE course_enrolments SET start_date = $2, end_date = $3 WHERE id = $1', [id, startDate, endDate]);
    await db.query('UPDATE student_profiles SET access_expired_on = NULL WHERE user_id = $1', [e.student_id]);
    await logActivity(
      {
        actorId: actor.id,
        action: 'enrolment.schedule_updated',
        entityType: 'enrolment',
        entityId: id,
        description: `${e.full_name}'s access to ${e.title} set to ${formatDay(startDate)} – ${dayLabel(endDate)}`,
        metadata: { studentId: e.student_id, previous: { startDate: e.start_date, endDate: e.end_date }, startDate, endDate },
      },
      db,
    );

    const { rows: restored } = await db.query(
      `UPDATE users u SET is_active = TRUE, deactivated_reason = NULL
         FROM student_access sa
        WHERE u.id = $1 AND sa.student_id = u.id AND NOT u.is_active AND u.deactivated_reason = 'course_expired'
          AND (sa.access_ends_on IS NULL OR sa.access_ends_on >= (now() AT TIME ZONE $2)::date)
      RETURNING u.id`,
      [e.student_id, env.timeZone],
    );
    if (restored.length) {
      await logActivity(
        {
          actorId: actor.id,
          action: 'student.access_restored',
          entityType: 'user',
          entityId: e.student_id,
          description: `${e.full_name}'s account reactivated: course access extended`,
        },
        db,
      );
      await notifyUsers(
        [e.student_id],
        { type: 'access_extended', title: `Your access to ${e.title} has been extended`, link: '/student' },
        db,
      );
    }
    const expired = await expireStudentAccounts({ studentId: e.student_id, db });
    return { accountReactivated: restored.length > 0, accountDeactivated: expired.length > 0 };
  });
}

/** Set what the student is charged for the course and any scholarship / discount. Payments already made are kept. */
export async function updateFee(id, { feeAmount, discountAmount }, actor) {
  if (discountAmount > feeAmount) throw invalid('discountAmount', 'The discount cannot be more than the fee');
  return withTransaction(async (db) => {
    const e = await findEnrolment(id, db);
    await db.query('UPDATE course_enrolments SET fee_amount = $2, discount_amount = $3 WHERE id = $1', [id, feeAmount, discountAmount]);
    const { currency } = await getFeeSettings(db);
    await logActivity(
      {
        actorId: actor.id,
        action: 'enrolment.fee_updated',
        entityType: 'enrolment',
        entityId: id,
        description: `${e.full_name}'s fee for ${e.title} set to ${formatMoney(feeAmount, currency)}${
          discountAmount ? ` less ${formatMoney(discountAmount, currency)} discount` : ''
        }`,
        metadata: {
          studentId: e.student_id,
          previous: { feeAmount: e.fee_amount, discountAmount: e.discount_amount },
          feeAmount,
          discountAmount,
        },
      },
      db,
    );
    await notifyUsers(
      [e.student_id],
      { type: 'fee_updated', title: `Your fee for ${e.title} has been updated`, link: '/student/fees' },
      db,
    );
    const { rows } = await db.query('SELECT * FROM enrolment_fees WHERE enrolment_id = $1', [id]);
    return rows[0];
  });
}
