import { withTransaction } from '../../../config/db.js';
import { notFound } from '../../../utils/AppError.js';
import { logActivity } from '../../../services/activity.service.js';
import * as referrals from '../../../repositories/referrals.repository.js';
import { getUserWithProfile, uniqueReferralCode } from '../../users/user.repository.js';
import { createManagedAccount } from '../accounts/accounts.service.js';
import * as repo from './agents.repository.js';

export const listAgents = (query) => repo.listAgents(query);

async function requireAgent(agentId) {
  const user = await getUserWithProfile(agentId);
  if (!user || user.role !== 'agent') throw notFound('Agent');
  return user;
}

export async function getAgent(agentId) {
  const user = await requireAgent(agentId);
  const [counts, monthly, byCourse] = await Promise.all([
    referrals.referralCounts(agentId),
    referrals.monthlyReferrals(agentId, 12),
    referrals.referralsByCourse(agentId),
  ]);
  return { ...user, referralCounts: counts, monthlyReferrals: monthly, referralsByCourse: byCourse };
}

export async function listAgentReferrals(agentId, query) {
  await requireAgent(agentId);
  return referrals.listReferrals({ ...query, agentId }, { includeContact: true });
}

export async function createAgent(data, actor) {
  const agent = await createManagedAccount('agent', data, actor);
  return { ...(await getAgent(agent.id)), welcomeEmail: agent.welcomeEmail };
}

/** Issue a new code. Old links stop working; existing referrals keep the code they were attributed with. */
export async function regenerateReferralCode(agentId, actor) {
  const agent = await requireAgent(agentId);
  await withTransaction(async (db) => {
    const code = await uniqueReferralCode(db);
    await repo.setReferralCode(agentId, code, db);
    await logActivity(
      {
        actorId: actor.id,
        action: 'agent.referral_code_regenerated',
        entityType: 'user',
        entityId: agentId,
        description: `Referral code for ${agent.full_name} changed to ${code}`,
        metadata: { previousCode: agent.profile.referral_code, code },
      },
      db,
    );
  });
  return getAgent(agentId);
}
