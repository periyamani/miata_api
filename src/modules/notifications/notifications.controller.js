import { notFound } from '../../utils/AppError.js';
import { send } from '../../utils/http.js';
import * as repo from './notifications.repository.js';

export async function list(req, res) {
  const { limit, unreadOnly } = req.valid.query;
  const [rows, unread] = await Promise.all([repo.listForUser(req.user.id, { limit, unreadOnly }), repo.unreadCount(req.user.id)]);
  send(res, rows, { meta: { unread } });
}

export async function markRead(req, res) {
  if (!(await repo.markRead(req.user.id, req.valid.params.id))) throw notFound('Notification');
  send(res, { read: true });
}

export async function markAllRead(req, res) {
  await repo.markAllRead(req.user.id);
  send(res, { read: true });
}
