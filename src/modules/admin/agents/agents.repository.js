import { pool } from '../../../config/db.js';
import { limitOffset, orderBy, paged, SqlBuilder } from '../../../utils/sql.js';

const SORTS = { full_name: 'u.full_name', created_at: 'u.created_at', referrals: 'total_referrals' };

export async function listAgents({ page, pageSize, search, sort, order, status }) {
  const q = new SqlBuilder();
  q.where(`u.role = 'agent'`);
  q.search(search, ['u.full_name', 'u.email', 'ap.referral_code', 'ap.organization', 'ap.city']);
  if (status) q.where(`u.is_active = ${q.param(status === 'active')}`);
  return paged(
    pool,
    `SELECT u.id, u.full_name, u.email, u.phone, u.is_active, u.created_at, u.last_login_at,
            ap.referral_code, ap.organization, ap.city, ap.country,
            count(r.id) AS total_referrals,
            count(r.id) FILTER (WHERE ss.status = 'active') AS active_referrals,
            count(r.id) FILTER (WHERE ss.status = 'pending') AS pending_referrals,
            count(r.id) FILTER (WHERE ss.status = 'completed') AS completed_referrals,
            count(*) OVER () AS total_count
       FROM users u
       JOIN agent_profiles ap ON ap.user_id = u.id
       LEFT JOIN agent_referrals r ON r.agent_id = u.id
       LEFT JOIN student_status ss ON ss.student_id = r.student_id
       ${q.whereClause()}
      GROUP BY u.id, ap.user_id
       ${orderBy(sort, order, SORTS, 'created_at')}
       ${limitOffset(q, { page, pageSize })}`,
    q.params,
  );
}

export async function setReferralCode(agentId, code, db) {
  await db.query('UPDATE agent_profiles SET referral_code = $2 WHERE user_id = $1', [agentId, code]);
}
