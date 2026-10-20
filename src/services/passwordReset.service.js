import { env } from '../config/env.js';
import { pool } from '../config/db.js';
import { randomToken, sha256 } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';
import { sendEmail } from './email.service.js';
import { passwordResetEmail } from './email.templates.js';

export const RESET_TOKEN_TTL_MINUTES = 30;
// Account set-up links (welcome e-mail) stay valid longer: the new user may not read the e-mail straight away.
export const SETUP_TOKEN_TTL_HOURS = 72;
const TTL_MINUTES = { reset: RESET_TOKEN_TTL_MINUTES, forced: RESET_TOKEN_TTL_MINUTES, setup: SETUP_TOKEN_TTL_HOURS * 60 };

/**
 * Create a single-use, expiring reset token (only its hash is stored). `purpose`: reset (forgot password),
 * forced (after sign-in) or setup (account set-up link). Any older unused token for the user is invalidated
 * so only the newest link works.
 */
export async function createPasswordResetToken(userId, purpose, db = pool) {
  await db.query('UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
  const token = randomToken(32);
  await db.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, purpose, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
    [userId, sha256(token), purpose, TTL_MINUTES[purpose]],
  );
  return token;
}

export const resetLink = (token) => `${env.frontendUrl}/reset-password?token=${encodeURIComponent(token)}`;

export async function sendPasswordResetEmail(user, token, { reason } = {}) {
  const link = resetLink(token);
  const result = await sendEmail({ to: user.email, ...passwordResetEmail(user, link, { reason }) });
  if (result.status === 'skipped' && env.nodeEnv === 'development') {
    // Development convenience only, so the flow can be tested without SMTP. Never logged in production.
    logger.warn(`[dev only] Password reset link for ${user.email}: ${link}`);
  }
  return result;
}
