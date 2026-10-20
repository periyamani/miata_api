import { withTransaction } from '../../config/db.js';
import { toColumns } from '../../utils/case.js';
import { logActivity } from '../../services/activity.service.js';
import { studentBatch } from '../../repositories/batches.repository.js';
import { getUserWithProfile, updateAccount } from '../users/user.repository.js';

/** Own user and role profile; students also see their batch (read-only, managed by admins). */
export async function getOwnProfile(userId) {
  const user = await getUserWithProfile(userId);
  if (user?.role !== 'student') return user;
  return { ...user, batch: await studentBatch(userId) };
}

export async function updateOwnProfile(user, data, ip) {
  const changes = toColumns(data);
  await withTransaction(async (db) => {
    await updateAccount(user, changes, db);
    await logActivity(
      {
        actorId: user.id,
        action: 'profile.updated',
        entityType: 'user',
        entityId: user.id,
        description: `${user.full_name} updated their profile`,
        metadata: { fields: Object.keys(changes) },
        ip,
      },
      db,
    );
  });
  return getOwnProfile(user.id);
}
