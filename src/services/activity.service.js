import { pool } from '../config/db.js';

/**
 * Append an audit/activity entry. Pass the transaction client as `db` when the action is part of one,
 * so the log entry is rolled back together with the action.
 */
export async function logActivity(
  { actorId = null, action, entityType = null, entityId = null, description, metadata = {}, ip = null },
  db = pool,
) {
  await db.query(
    `INSERT INTO activity_logs (actor_id, action, entity_type, entity_id, description, metadata, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actorId, action, entityType, entityId, description, JSON.stringify(metadata), ip],
  );
}
