import { pool, query, withTransaction } from '../../config/db.js';
import { AppError, unauthorized } from '../../utils/AppError.js';
import { hashPassword, sha256, verifyAgainstDummy, verifyPassword } from '../../utils/crypto.js';
import { logger } from '../../utils/logger.js';
import { expireStudentAccounts } from '../../services/accessExpiry.service.js';
import { logActivity } from '../../services/activity.service.js';
import { notifyRole, notifyUsers } from '../../services/notification.service.js';
import { createPasswordResetToken, sendPasswordResetEmail } from '../../services/passwordReset.service.js';
import {
  endAllSessions,
  issueRefreshToken,
  revokeAllRefreshTokens,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
} from '../../services/token.service.js';
import { createAccount, findUserByEmail, getUserWithProfile } from '../users/user.repository.js';

const invalidCredentials = () => new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password');
const ROLE_LABEL = { admin: 'Admin', agent: 'Agent', professor: 'Professor', student: 'Student' };

async function startSession(user, meta, db = pool) {
  const refresh = await issueRefreshToken(user.id, meta, db);
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  return { accessToken: signAccessToken(user), refresh, user: await getUserWithProfile(user.id, db) };
}

/**
 * Verify credentials for the role chosen on the login page. If the account owes a password reset
 * (first login, course completion), no session is created: a single-use reset token is returned
 * instead, so the reset cannot be skipped.
 */
export async function login({ email, password, remember, role }, meta) {
  const user = await findUserByEmail(email);
  if (!user) {
    await verifyAgainstDummy(password);
    throw invalidCredentials();
  }
  if (!(await verifyPassword(password, user.password_hash))) {
    await logActivity({
      actorId: user.id,
      action: 'auth.login_failed',
      entityType: 'user',
      entityId: user.id,
      description: `Failed login for ${user.email}`,
      ip: meta.ip,
    });
    throw invalidCredentials();
  }
  // Checked only after the password, so the role of an account is never revealed to strangers.
  if (role && user.role !== role) {
    throw new AppError(
      403,
      'ROLE_MISMATCH',
      `This account is not a ${ROLE_LABEL[role]} account. Please use the ${ROLE_LABEL[user.role]} login.`,
      { role: user.role },
    );
  }
  // A student whose course access period has ended is deactivated now, even if the periodic check has not run yet.
  if (user.role === 'student' && user.is_active && (await expireStudentAccounts({ studentId: user.id })).length) {
    user.is_active = false;
    user.deactivated_reason = 'course_expired';
  }
  if (!user.is_active) {
    throw new AppError(
      403,
      'ACCOUNT_DISABLED',
      user.deactivated_reason === 'course_expired'
        ? 'Your course access period has ended, so your account has been deactivated. Please contact MIATA to extend your access.'
        : 'Your account has been deactivated. Please contact MIATA.',
    );
  }
  if (user.must_reset_password) {
    const resetToken = await createPasswordResetToken(user.id, 'forced');
    return { passwordResetRequired: true, resetToken, reason: user.password_reset_reason, email: user.email };
  }
  const session = await startSession(user, { persistent: remember, userAgent: meta.userAgent, ip: meta.ip });
  await logActivity({
    actorId: user.id,
    action: 'auth.login',
    entityType: 'user',
    entityId: user.id,
    description: `${user.full_name} signed in`,
    ip: meta.ip,
  });
  return session;
}

/** Student self-registration, optionally through an agent referral code. Starts a session. */
export async function register({ fullName, email, phone, password, referralCode }, meta) {
  return withTransaction(async (db) => {
    let agent = null;
    if (referralCode) {
      const { rows } = await db.query(
        `SELECT u.id, u.full_name, ap.referral_code
           FROM agent_profiles ap JOIN users u ON u.id = ap.user_id
          WHERE ap.referral_code = $1 AND u.is_active AND u.role = 'agent'`,
        [referralCode],
      );
      agent = rows[0];
      if (!agent) {
        throw new AppError(422, 'VALIDATION_ERROR', 'Please correct the highlighted fields', {
          referralCode: 'This referral code is not valid',
        });
      }
    }

    const user = await createAccount({ role: 'student', email, fullName, phone, password }, db);

    if (agent) {
      await db.query(`INSERT INTO agent_referrals (agent_id, student_id, referral_code, source) VALUES ($1, $2, $3, 'link')`, [
        agent.id,
        user.id,
        agent.referral_code,
      ]);
      await notifyUsers(
        [agent.id],
        {
          type: 'referral_registered',
          title: `New referral: ${fullName}`,
          body: 'A student registered with your referral link.',
          link: '/agent/students',
        },
        db,
      );
    }
    await notifyRole(
      'admin',
      {
        type: 'student_registered',
        title: `New student registration: ${fullName}`,
        body: agent ? `Referred by ${agent.full_name}` : null,
        link: `/admin/students/${user.id}`,
      },
      db,
    );
    await logActivity(
      {
        actorId: user.id,
        action: 'student.registered',
        entityType: 'user',
        entityId: user.id,
        description: agent ? `${fullName} registered via ${agent.full_name}'s referral link` : `${fullName} registered`,
        metadata: agent ? { agentId: agent.id, referralCode: agent.referral_code } : {},
        ip: meta.ip,
      },
      db,
    );
    return startSession(user, { persistent: false, userAgent: meta.userAgent, ip: meta.ip }, db);
  });
}

export async function lookupReferralCode(code) {
  const { rows } = await query(
    `SELECT u.full_name, ap.organization
       FROM agent_profiles ap JOIN users u ON u.id = ap.user_id
      WHERE ap.referral_code = $1 AND u.is_active`,
    [code],
  );
  return rows[0] ? { valid: true, agentName: rows[0].full_name, organization: rows[0].organization } : { valid: false };
}

/** Rotate the refresh token. Revocations (reuse detection) are committed even when access is refused. */
export async function refreshSession(rawToken, meta) {
  if (!rawToken) throw unauthorized('Please log in', 'NO_SESSION');
  const result = await withTransaction(async (db) => {
    const rotated = await rotateRefreshToken(rawToken, meta, db);
    if (rotated.status !== 'ok') return rotated;
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [rotated.userId]);
    const user = rows[0];
    if (!user || !user.is_active || user.must_reset_password) {
      await revokeAllRefreshTokens(rotated.userId, db);
      return { status: user?.must_reset_password ? 'reset_required' : 'disabled' };
    }
    return { status: 'ok', user, next: rotated.next, profile: await getUserWithProfile(user.id, db) };
  });

  switch (result.status) {
    case 'ok':
      return { accessToken: signAccessToken(result.user), refresh: result.next, user: result.profile };
    case 'reset_required':
      throw unauthorized('You must set a new password before continuing', 'PASSWORD_RESET_REQUIRED');
    case 'disabled':
      throw unauthorized('Your account has been deactivated', 'ACCOUNT_DISABLED');
    case 'reused':
      logger.warn('Refresh token reuse detected — all sessions revoked', { userId: result.userId });
      throw unauthorized('Your session has ended. Please log in again.', 'SESSION_REVOKED');
    default:
      throw unauthorized('Your session has expired. Please log in again.', 'SESSION_EXPIRED');
  }
}

export async function logout(rawToken) {
  if (rawToken) await revokeRefreshToken(rawToken);
}

/** Always resolves the same way so the response never reveals whether an account exists. */
export async function requestPasswordReset(email, meta) {
  const user = await findUserByEmail(email);
  if (!user || !user.is_active) return;
  const token = await createPasswordResetToken(user.id, 'reset');
  await logActivity({
    actorId: user.id,
    action: 'auth.password_reset_requested',
    entityType: 'user',
    entityId: user.id,
    description: `Password reset requested for ${user.email}`,
    ip: meta.ip,
  });
  // Not awaited: response time must not depend on whether an email is sent.
  sendPasswordResetEmail(user, token, { reason: user.password_reset_reason }).catch((err) =>
    logger.error('Password reset email error', { error: err.message }),
  );
}

async function findUsableResetToken(token, db, { lock = false } = {}) {
  const { rows } = await db.query(
    `SELECT t.id, t.user_id, t.purpose, u.email, u.full_name, u.password_hash, u.is_active, u.password_reset_reason
       FROM password_reset_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()
      ${lock ? 'FOR UPDATE OF t' : ''}`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row || !row.is_active) {
    throw new AppError(400, 'INVALID_RESET_TOKEN', 'This password reset link is invalid or has expired. Please request a new one.');
  }
  return row;
}

export async function verifyResetToken(token) {
  const row = await findUsableResetToken(token, pool);
  return { valid: true, email: row.email, purpose: row.purpose, reason: row.password_reset_reason };
}

export async function resetPassword({ token, password }, meta) {
  return withTransaction(async (db) => {
    const row = await findUsableResetToken(token, db, { lock: true });
    if (await verifyPassword(password, row.password_hash)) {
      throw new AppError(422, 'VALIDATION_ERROR', 'Please choose a new password', {
        password: 'Your new password must be different from your current password',
      });
    }
    await db.query(`UPDATE users SET password_hash = $2, must_reset_password = FALSE, password_reset_reason = NULL WHERE id = $1`, [
      row.user_id,
      await hashPassword(password),
    ]);
    await db.query('UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [row.user_id]);
    await endAllSessions(row.user_id, db);
    await logActivity(
      {
        actorId: row.user_id,
        action: 'auth.password_reset',
        entityType: 'user',
        entityId: row.user_id,
        description: `${row.full_name} set a new password`,
        metadata: { purpose: row.purpose },
        ip: meta.ip,
      },
      db,
    );
    return { email: row.email };
  });
}

/** Change password while signed in. Ends every other session and returns a fresh one for this device. */
export async function changePassword(userId, { currentPassword, newPassword }, meta) {
  return withTransaction(async (db) => {
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const user = rows[0];
    if (!(await verifyPassword(currentPassword, user.password_hash))) {
      throw new AppError(422, 'VALIDATION_ERROR', 'Please correct the highlighted fields', {
        currentPassword: 'Current password is incorrect',
      });
    }
    if (currentPassword === newPassword) {
      throw new AppError(422, 'VALIDATION_ERROR', 'Please correct the highlighted fields', {
        newPassword: 'Choose a password different from your current one',
      });
    }
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, await hashPassword(newPassword)]);
    await endAllSessions(userId, db);
    await logActivity(
      {
        actorId: userId,
        action: 'auth.password_changed',
        entityType: 'user',
        entityId: userId,
        description: `${user.full_name} changed their password`,
        ip: meta.ip,
      },
      db,
    );
    const { rows: fresh } = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    return startSession(fresh[0], { persistent: meta.persistent, userAgent: meta.userAgent, ip: meta.ip }, db);
  });
}
