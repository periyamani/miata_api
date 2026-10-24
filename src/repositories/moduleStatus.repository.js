import { pool } from '../config/db.js';

// How far the teaching of a module has got (migration 017). A module without a module_statuses row is not started.
export const MODULE_STATUSES = ['not_started', 'in_progress', 'completed'];

/** The teaching status of a module aliased `m`, with when it started / was completed and who last changed it. */
export const TEACHING_STATUS_COLUMNS = `
  COALESCE(ms.status, 'not_started') AS teaching_status, ms.started_at AS teaching_started_at,
  ms.completed_at AS teaching_completed_at, ms.updated_at AS teaching_updated_at, msu.full_name AS teaching_updated_by`;
export const TEACHING_STATUS_JOIN = 'LEFT JOIN module_statuses ms ON ms.module_id = m.id LEFT JOIN users msu ON msu.id = ms.updated_by';

/**
 * Set a module's teaching status. Going in progress or completed keeps the first start; completing stamps the
 * completion; going back to not started clears both.
 */
export async function setTeachingStatus(moduleId, status, userId, db = pool) {
  await db.query(
    `INSERT INTO module_statuses (module_id, status, started_at, completed_at, updated_by)
     VALUES ($1, $2::text, CASE WHEN $2::text <> 'not_started' THEN now() END, CASE WHEN $2::text = 'completed' THEN now() END, $3)
     ON CONFLICT (module_id) DO UPDATE SET
       status = EXCLUDED.status,
       started_at = CASE WHEN EXCLUDED.status = 'not_started' THEN NULL ELSE COALESCE(module_statuses.started_at, EXCLUDED.started_at) END,
       completed_at = EXCLUDED.completed_at,
       updated_by = EXCLUDED.updated_by`,
    [moduleId, status, userId],
  );
}
