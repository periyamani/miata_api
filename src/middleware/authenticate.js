import { query } from '../config/db.js';
import { verifyAccessToken } from '../services/token.service.js';
import { forbidden, unauthorized } from '../utils/AppError.js';

const SESSION_USER_SQL = `
  SELECT id, email, full_name, role, is_active, must_reset_password, token_version
    FROM users WHERE id = $1`;

export async function loadSessionUser(userId) {
  const { rows } = await query(SESSION_USER_SQL, [userId]);
  return rows[0] || null;
}

/**
 * The account behind a token must still exist, be active, have the same token version
 * (bumped on logout-everywhere / deactivation / course completion) and not owe a password reset.
 */
export function assertSessionUsable(user, tokenVersion) {
  if (!user) throw unauthorized('Your session is no longer valid', 'INVALID_TOKEN');
  if (!user.is_active) throw unauthorized('Your account has been deactivated', 'ACCOUNT_DISABLED');
  if (user.token_version !== tokenVersion) throw unauthorized('Your session has ended. Please log in again.', 'SESSION_REVOKED');
  if (user.must_reset_password) {
    throw unauthorized('You must set a new password before continuing', 'PASSWORD_RESET_REQUIRED');
  }
}

export async function authenticate(req, _res, next) {
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme !== 'Bearer' || !token) throw unauthorized();

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw unauthorized('Session expired', 'TOKEN_EXPIRED');
    throw unauthorized('Invalid session token', 'INVALID_TOKEN');
  }

  const user = await loadSessionUser(Number(payload.sub));
  assertSessionUsable(user, payload.tv);
  req.user = user;
  next();
}

/** Role guard. Always combine with resource-level scoping inside the service. */
export const authorize =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) throw forbidden();
    next();
  };
