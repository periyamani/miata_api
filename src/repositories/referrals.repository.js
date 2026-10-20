import { pool } from '../config/db.js';
import { limitOffset, orderBy, paged, SqlBuilder } from '../utils/sql.js';

const SORTS = {
  full_name: 'u.full_name',
  registered_at: 'u.created_at',
  status: 'ss.status',
  agent: 'ag.full_name',
  student_code: 'sp.student_code',
};

const FROM = `
  FROM agent_referrals r
  JOIN users u ON u.id = r.student_id
  JOIN student_profiles sp ON sp.user_id = u.id
  JOIN student_status ss ON ss.student_id = u.id
  JOIN users ag ON ag.id = r.agent_id
  JOIN agent_profiles ap ON ap.user_id = ag.id
  LEFT JOIN courses ac ON ac.id = r.applied_course_id`;

/**
 * Referral filters. `agentId` is mandatory for agent callers (enforced by the agent service);
 * `includeContact` adds email/phone, which only admins may see.
 */
function buildFilters({ agentId, status, courseId, search }, includeContact) {
  const q = new SqlBuilder();
  if (agentId) q.where(`r.agent_id = ${q.param(agentId)}`);
  if (status) q.where(`ss.status = ${q.param(status)}`);
  if (courseId) {
    q.where(`EXISTS (SELECT 1 FROM course_enrolments e WHERE e.student_id = u.id AND e.course_id = ${q.param(courseId)})`);
  }
  q.search(search, ['u.full_name', 'sp.student_code', ...(includeContact ? ['u.email', 'ag.full_name'] : [])]);
  return q;
}

const columns = (includeContact) => `
  r.id AS referral_id, r.source, r.referral_code, r.created_at AS referred_at,
  u.id AS student_id, u.full_name, sp.student_code, u.created_at AS registered_at,
  ${includeContact ? 'u.email, u.phone, u.is_active,' : ''}
  ss.status, ss.course_titles, ss.enrolment_count,
  ag.id AS agent_id, ag.full_name AS agent_name, ap.referral_code AS agent_code,
  r.applied_course_id, ac.title AS applied_course_title, r.notes AS application_notes`;

export async function listReferrals(filters, { includeContact = false } = {}) {
  const q = buildFilters(filters, includeContact);
  return paged(
    pool,
    `SELECT ${columns(includeContact)}, count(*) OVER () AS total_count
     ${FROM} ${q.whereClause()}
     ${orderBy(filters.sort, filters.order, SORTS, 'registered_at')}
     ${limitOffset(q, filters)}`,
    q.params,
  );
}

export async function exportReferrals(filters, { includeContact = false } = {}) {
  const q = buildFilters(filters, includeContact);
  const { rows } = await pool.query(
    `SELECT ${columns(includeContact)} ${FROM} ${q.whereClause()} ORDER BY u.created_at DESC LIMIT 10000`,
    q.params,
  );
  return rows;
}

export async function findReferralForStudent(studentId, agentId = null) {
  const { rows } = await pool.query(
    `SELECT ${columns(false)} ${FROM} WHERE r.student_id = $1 AND ($2::bigint IS NULL OR r.agent_id = $2)`,
    [studentId, agentId],
  );
  return rows[0] || null;
}

/** Counts by derived status — always computed from records, never stored. */
export async function referralCounts(agentId = null) {
  const { rows } = await pool.query(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE ss.status = 'active') AS active,
            count(*) FILTER (WHERE ss.status = 'pending') AS pending,
            count(*) FILTER (WHERE ss.status = 'completed') AS completed,
            count(*) FILTER (WHERE ss.status = 'inactive') AS inactive,
            count(*) FILTER (WHERE r.created_at >= date_trunc('month', now())) AS this_month
       FROM agent_referrals r JOIN student_status ss ON ss.student_id = r.student_id
      WHERE ($1::bigint IS NULL OR r.agent_id = $1)`,
    [agentId],
  );
  return rows[0];
}

/** New referrals per calendar month for the last `months` months, plus the running total. */
export async function monthlyReferrals(agentId, months) {
  const { rows } = await pool.query(
    `WITH series AS (
       SELECT generate_series(date_trunc('month', now()) - make_interval(months => $2 - 1),
                              date_trunc('month', now()), interval '1 month') AS month
     ),
     counts AS (
       SELECT s.month, count(r.id) AS count
         FROM series s
         LEFT JOIN agent_referrals r ON date_trunc('month', r.created_at) = s.month
                                     AND ($1::bigint IS NULL OR r.agent_id = $1)
        GROUP BY s.month
     )
     SELECT to_char(c.month, 'YYYY-MM') AS month, c.count,
            (SELECT count(*) FROM agent_referrals r
              WHERE r.created_at < c.month + interval '1 month' AND ($1::bigint IS NULL OR r.agent_id = $1)) AS cumulative
       FROM counts c ORDER BY c.month`,
    [agentId, months],
  );
  return rows;
}

export async function referralsByCourse(agentId = null) {
  const { rows } = await pool.query(
    `SELECT c.id AS course_id, c.title, count(*) AS students,
            count(*) FILTER (WHERE e.status = 'completed') AS completed
       FROM agent_referrals r
       JOIN course_enrolments e ON e.student_id = r.student_id
       JOIN courses c ON c.id = e.course_id
      WHERE ($1::bigint IS NULL OR r.agent_id = $1)
      GROUP BY c.id ORDER BY students DESC, c.title`,
    [agentId],
  );
  return rows;
}

/** Per-agent summary for the admin referral report. */
export async function agentReferralSummary() {
  const { rows } = await pool.query(
    `SELECT ag.id AS agent_id, ag.full_name AS agent_name, ap.referral_code, ag.is_active,
            count(r.id) AS total,
            count(r.id) FILTER (WHERE ss.status = 'active') AS active,
            count(r.id) FILTER (WHERE ss.status = 'pending') AS pending,
            count(r.id) FILTER (WHERE ss.status = 'completed') AS completed,
            count(r.id) FILTER (WHERE ss.status = 'inactive') AS inactive
       FROM users ag
       JOIN agent_profiles ap ON ap.user_id = ag.id
       LEFT JOIN agent_referrals r ON r.agent_id = ag.id
       LEFT JOIN student_status ss ON ss.student_id = r.student_id
      WHERE ag.role = 'agent'
      GROUP BY ag.id, ap.referral_code
      ORDER BY total DESC, ag.full_name`,
  );
  return rows;
}
