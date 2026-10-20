import { pool } from '../../config/db.js';
import { AppError, notFound } from '../../utils/AppError.js';
import { toCsv } from '../../utils/csv.js';
import { logActivity } from '../../services/activity.service.js';
import { isEmailConfigured } from '../../services/email.service.js';
import { notifyRole } from '../../services/notification.service.js';
import { attachProgress } from '../../services/progress.service.js';
import { getCompletionPolicy, getFeeSettings } from '../../services/settings.service.js';
import * as referrals from '../../repositories/referrals.repository.js';
import { referralLink } from '../users/user.repository.js';
import { createManagedAccount } from '../admin/accounts/accounts.service.js';

// Every function takes the signed-in agent's id and passes it as a mandatory filter:
// an agent can never see another agent's students. Contact details are not exposed to agents.

async function referralCode(agentId) {
  const { rows } = await pool.query('SELECT referral_code FROM agent_profiles WHERE user_id = $1', [agentId]);
  return rows[0].referral_code;
}

export async function dashboard(agentId, months) {
  const [counts, monthly, recent, code] = await Promise.all([
    referrals.referralCounts(agentId),
    referrals.monthlyReferrals(agentId, months),
    referrals.listReferrals({ agentId, page: 1, pageSize: 5, order: 'desc' }),
    referralCode(agentId),
  ]);
  return { counts, monthly, recentStudents: recent.rows, referralCode: code, referralLink: referralLink(code) };
}

export const listStudents = (agentId, query) => referrals.listReferrals({ ...query, agentId });

export async function getStudent(agentId, studentId) {
  const referral = await referrals.findReferralForStudent(studentId, agentId);
  if (!referral) throw notFound('Student');
  const [{ rows: enrolments }, policy] = await Promise.all([
    pool.query(
      `SELECT e.status, e.enrolled_at, e.completed_at, c.title AS course_title,
              ep.videos_total, ep.videos_done, ep.assignments_total, ep.assignments_done
         FROM course_enrolments e JOIN courses c ON c.id = e.course_id
         JOIN enrolment_progress ep ON ep.enrolment_id = e.id
        WHERE e.student_id = $1 ORDER BY e.enrolled_at DESC`,
      [studentId],
    ),
    getCompletionPolicy(),
  ]);
  return { ...referral, enrolments: attachProgress(enrolments, policy) };
}

export async function stats(agentId, months) {
  const [counts, monthly, byCourse] = await Promise.all([
    referrals.referralCounts(agentId),
    referrals.monthlyReferrals(agentId, months),
    referrals.referralsByCourse(agentId),
  ]);
  return { counts, monthly, byCourse };
}

export async function studentsCsv(agentId, filters) {
  const rows = await referrals.exportReferrals({ ...filters, agentId });
  return toCsv(rows, [
    { header: 'Student', value: (r) => r.full_name },
    { header: 'Student ID', value: (r) => r.student_code },
    { header: 'Courses', value: (r) => r.course_titles },
    { header: 'Registered', value: (r) => r.registered_at },
    { header: 'Status', value: (r) => r.status },
  ]);
}

// ─── Apply Now: the agent registers a referred student ─────────────────

/** Active courses a student can apply for, and whether the welcome e-mail can be sent (else a temporary password is needed). */
export async function applyOptions() {
  const [{ rows: courses }, { currency }] = await Promise.all([
    pool.query(
      `SELECT id, title, code, category, duration_value, duration_unit, fee_amount
         FROM courses WHERE is_active ORDER BY title`,
    ),
    getFeeSettings(),
  ]);
  return { courses, currency, emailConfigured: isEmailConfigured() };
}

/**
 * Register a student on behalf of the signed-in agent. The account is created exactly like an admin-created one (welcome
 * e-mail with a set-password link, or a temporary password to hand over) and attributed to this agent. Enrolment stays
 * with MIATA: the course applied for is recorded on the referral and the admins are notified.
 */
export async function applyForStudent(agent, data) {
  let course = null;
  if (data.courseId) {
    const { rows } = await pool.query('SELECT id, title FROM courses WHERE id = $1 AND is_active', [data.courseId]);
    course = rows[0];
    if (!course) throw new AppError(422, 'VALIDATION_ERROR', 'Select an active course', { courseId: 'Select an active course' });
  }
  const student = await createManagedAccount('student', data, agent, async (user, db) => {
    await db.query(
      `INSERT INTO agent_referrals (agent_id, student_id, referral_code, source, created_by, applied_course_id, notes)
       SELECT $1, $2, ap.referral_code, 'agent', $1, $3, $4 FROM agent_profiles ap WHERE ap.user_id = $1`,
      [agent.id, user.id, course?.id ?? null, data.notes],
    );
    await notifyRole(
      'admin',
      {
        type: 'student_registered',
        title: `New application from ${agent.full_name}: ${user.full_name}`,
        body: course ? `Applied for ${course.title}` : 'No course chosen yet',
        link: `/admin/students/${user.id}`,
      },
      db,
    );
    await logActivity(
      {
        actorId: agent.id,
        action: 'referral.applied',
        entityType: 'user',
        entityId: user.id,
        description: `${agent.full_name} registered ${user.full_name}${course ? ` for ${course.title}` : ''} (Apply Now)`,
        metadata: { agentId: agent.id, courseId: course?.id ?? null },
      },
      db,
    );
  });
  return {
    id: student.id,
    fullName: student.full_name,
    studentCode: student.profile?.student_code,
    welcomeEmail: student.welcomeEmail,
  };
}
