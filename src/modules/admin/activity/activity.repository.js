import { pool } from '../../../config/db.js';
import { escapeLike, limitOffset, paged, SqlBuilder } from '../../../utils/sql.js';

export async function listActivity({ page, pageSize, search, action, actorId, entityType, entityId }) {
  const q = new SqlBuilder();
  q.search(search, ['a.description', 'u.full_name']);
  if (action) q.where(`a.action LIKE ${q.param(`${escapeLike(action)}%`)}`);
  if (actorId) q.where(`a.actor_id = ${q.param(actorId)}`);
  if (entityType) q.where(`a.entity_type = ${q.param(entityType)}`);
  if (entityId) q.where(`a.entity_id = ${q.param(entityId)}`);
  return paged(
    pool,
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.description, a.metadata, a.ip_address, a.created_at,
            u.id AS actor_id, u.full_name AS actor_name, u.role AS actor_role,
            count(*) OVER () AS total_count
       FROM activity_logs a LEFT JOIN users u ON u.id = a.actor_id
       ${q.whereClause()}
      ORDER BY a.created_at DESC
       ${limitOffset(q, { page, pageSize })}`,
    q.params,
  );
}
