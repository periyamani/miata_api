import { pool } from '../../../config/db.js';
import { limitOffset, orderBy, paged, SqlBuilder } from '../../../utils/sql.js';

const SORTS = {
  full_name: 'u.full_name',
  created_at: 'u.created_at',
  student_code: 'sp.student_code',
  status: 'ss.status',
  batch: 'b.name',
};

export async function listStudents({ page, pageSize, search, sort, order, status, courseId, agentId, batchId, referred }) {
  const q = new SqlBuilder();
  q.where(`u.role = 'student'`);
  q.search(search, ['u.full_name', 'u.email', 'sp.student_code', 'u.phone']);
  if (status) q.where(`ss.status = ${q.param(status)}`);
  if (courseId) q.where(`EXISTS (SELECT 1 FROM course_enrolments e WHERE e.student_id = u.id AND e.course_id = ${q.param(courseId)})`);
  if (agentId) q.where(`r.agent_id = ${q.param(agentId)}`);
  if (batchId === 'none') q.where('bs.id IS NULL');
  else if (batchId) q.where(`bs.batch_id = ${q.param(batchId)}`);
  if (referred === true) q.where('r.id IS NOT NULL');
  if (referred === false) q.where('r.id IS NULL');
  return paged(
    pool,
    `SELECT u.id, u.full_name, u.email, u.phone, u.is_active, u.created_at, u.last_login_at,
            sp.student_code, ss.status, ss.course_titles, ss.enrolment_count,
            r.agent_id, ag.full_name AS agent_name,
            b.id AS batch_id, b.name AS batch_name, b.code AS batch_code,
            count(*) OVER () AS total_count
       FROM users u
       JOIN student_profiles sp ON sp.user_id = u.id
       JOIN student_status ss ON ss.student_id = u.id
       LEFT JOIN agent_referrals r ON r.student_id = u.id
       LEFT JOIN users ag ON ag.id = r.agent_id
       LEFT JOIN batch_students bs ON bs.student_id = u.id
       LEFT JOIN batches b ON b.id = bs.batch_id
       ${q.whereClause()}
       ${orderBy(sort, order, SORTS, 'created_at')}
       ${limitOffset(q, { page, pageSize })}`,
    q.params,
  );
}

/** When the student's access ends (latest course end date), and the end date that last deactivated them, if any. */
export async function studentAccess(studentId) {
  const { rows } = await pool.query(
    `SELECT sa.access_ends_on, sp.access_expired_on
       FROM student_profiles sp LEFT JOIN student_access sa ON sa.student_id = sp.user_id
      WHERE sp.user_id = $1`,
    [studentId],
  );
  return rows[0] || { access_ends_on: null, access_expired_on: null };
}

export async function studentStatus(studentId) {
  const { rows } = await pool.query('SELECT status, course_titles, enrolment_count FROM student_status WHERE student_id = $1', [studentId]);
  return rows[0] || null;
}

export async function studentReferral(studentId) {
  const { rows } = await pool.query(
    `SELECT r.id, r.source, r.referral_code, r.created_at, ag.id AS agent_id, ag.full_name AS agent_name, ap.referral_code AS agent_code,
            r.applied_course_id, ac.title AS applied_course_title, r.notes
       FROM agent_referrals r JOIN users ag ON ag.id = r.agent_id JOIN agent_profiles ap ON ap.user_id = ag.id
       LEFT JOIN courses ac ON ac.id = r.applied_course_id
      WHERE r.student_id = $1`,
    [studentId],
  );
  return rows[0] || null;
}

/**
 * Enrolments with the raw counts needed to compute progress, the batch each course is taken with (if any), the access
 * period and the fee position (payable, paid, pending, balance).
 */
export async function studentEnrolments(studentId) {
  const { rows } = await pool.query(
    `SELECT e.id AS enrolment_id, e.status, e.enrolled_at, e.completed_at, e.start_date, e.end_date,
            c.id AS course_id, c.title AS course_title, c.code AS course_code, c.is_active AS course_active,
            c.duration_value, c.duration_unit,
            eb.id AS batch_id, eb.name AS batch_name,
            ep.videos_total, ep.videos_done, ep.assignments_total, ep.assignments_done,
            ef.fee_amount, ef.discount_amount, ef.payable, ef.paid, ef.pending, ef.balance
       FROM course_enrolments e
       JOIN courses c ON c.id = e.course_id
       JOIN enrolment_progress ep ON ep.enrolment_id = e.id
       JOIN enrolment_fees ef ON ef.enrolment_id = e.id
       LEFT JOIN batches eb ON eb.id = enrolment_batch_id(e.student_id, e.course_id)
      WHERE e.student_id = $1 ORDER BY e.enrolled_at DESC`,
    [studentId],
  );
  return rows;
}

export async function recentActivityFor(userId, limit = 10) {
  const { rows } = await pool.query(
    `SELECT id, action, description, created_at FROM activity_logs
      WHERE actor_id = $1 AND action NOT LIKE 'auth.%'
      ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows;
}
