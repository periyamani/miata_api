import * as referrals from '../../../repositories/referrals.repository.js';
import { toCsv } from '../../../utils/csv.js';

export const listReferrals = (query) => referrals.listReferrals(query, { includeContact: true });

export async function referralReport() {
  const [totals, byAgent, monthly, byCourse] = await Promise.all([
    referrals.referralCounts(null),
    referrals.agentReferralSummary(),
    referrals.monthlyReferrals(null, 12),
    referrals.referralsByCourse(null),
  ]);
  return { totals, byAgent, monthly, byCourse };
}

export async function referralCsv(filters) {
  const rows = await referrals.exportReferrals(filters, { includeContact: true });
  return toCsv(rows, [
    { header: 'Student', value: (r) => r.full_name },
    { header: 'Student ID', value: (r) => r.student_code },
    { header: 'Email', value: (r) => r.email },
    { header: 'Phone', value: (r) => r.phone },
    { header: 'Agent', value: (r) => r.agent_name },
    { header: 'Agent code', value: (r) => r.agent_code },
    { header: 'Courses', value: (r) => r.course_titles },
    { header: 'Status', value: (r) => r.status },
    { header: 'Registered', value: (r) => r.registered_at },
    { header: 'Attribution', value: (r) => r.source },
  ]);
}
