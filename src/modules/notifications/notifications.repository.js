import { query } from '../../config/db.js';

export async function listForUser(userId, { limit, unreadOnly }) {
  const { rows } = await query(
    `SELECT id, type, title, body, link, read_at, created_at FROM notifications
      WHERE user_id = $1 AND ($3::boolean IS FALSE OR read_at IS NULL)
      ORDER BY created_at DESC LIMIT $2`,
    [userId, limit, unreadOnly],
  );
  return rows;
}

export async function unreadCount(userId) {
  const { rows } = await query('SELECT count(*) AS unread FROM notifications WHERE user_id = $1 AND read_at IS NULL', [userId]);
  return rows[0].unread;
}

/** Returns false when the notification does not exist or belongs to someone else. */
export async function markRead(userId, id) {
  const { rowCount } = await query('UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2', [
    id,
    userId,
  ]);
  return rowCount > 0;
}

export async function markAllRead(userId) {
  await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [userId]);
}
