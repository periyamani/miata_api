import { env } from '../../../config/env.js';
import { withTransaction } from '../../../config/db.js';
import { AppError, conflict, notFound } from '../../../utils/AppError.js';
import { toColumns } from '../../../utils/case.js';
import { hashPassword, randomToken } from '../../../utils/crypto.js';
import { logger } from '../../../utils/logger.js';
import { acknowledgeEndedAccess } from '../../../services/accessExpiry.service.js';
import { logActivity } from '../../../services/activity.service.js';
import { isEmailConfigured } from '../../../services/email.service.js';
import { queueEmails, sendOne } from '../../../services/emailDelivery.service.js';
import { welcomeEmail } from '../../../services/email.templates.js';
import { createPasswordResetToken, resetLink, SETUP_TOKEN_TTL_HOURS } from '../../../services/passwordReset.service.js';
import { endAllSessions } from '../../../services/token.service.js';
import { createAccount, getUserWithProfile, PROFILE_FIELDS, updateAccount } from '../../users/user.repository.js';

const LABEL = { student: 'Student', professor: 'Professor', agent: 'Agent' };
const CODE_LABEL = {
  student: ['student_code', 'Student ID'],
  professor: ['employee_code', 'Employee ID'],
  agent: ['referral_code', 'Referral code'],
};

/** Account details for the welcome e-mail: who they are, how they sign in, and their courses. */
async function accountDetails(user, db) {
  const full = await getUserWithProfile(user.id, db);
  const [codeColumn, codeLabel] = CODE_LABEL[user.role];
  const { rows } = await db.query(
    `SELECT c.title FROM courses c
      WHERE c.id IN (SELECT course_id FROM course_enrolments WHERE student_id = $1
                     UNION SELECT course_id FROM professor_course_assignments WHERE professor_id = $1
                     UNION SELECT m.course_id FROM professor_module_assignments pma JOIN modules m ON m.id = pma.module_id
                      WHERE pma.professor_id = $1)
      ORDER BY c.title`,
    [user.id],
  );
  return [
    ['Name', full.full_name],
    ['E-mail (your username)', full.email],
    ['Role', LABEL[user.role]],
    [codeLabel, full.profile?.[codeColumn]],
    ['Courses', rows.map((r) => r.title).join(', ')],
  ].filter(([, value]) => value);
}

/**
 * Create a single-use set-up link and queue the welcome e-mail in the caller's transaction (`db`).
 * The returned item is sent with sendQueued() once the transaction has committed.
 */
async function queueSetupEmail(user, { kind, dedupeKey, resend = false }, db) {
  const link = resetLink(await createPasswordResetToken(user.id, 'setup', db));
  const message = welcomeEmail(user, {
    setupLink: link,
    validHours: SETUP_TOKEN_TTL_HOURS,
    details: await accountDetails(user, db),
    resend,
  });
  const [queued] = await queueEmails([{ dedupeKey, kind, user, message }], db);
  return { queued, link };
}

async function sendSetupEmail({ queued, link }, user) {
  const { status, error = null } = await sendOne(queued);
  if (status === 'skipped' && env.nodeEnv === 'development') {
    // Development convenience only, so the flow can be tested without SMTP. Never logged in production.
    logger.warn(`[dev only] Account set-up link for ${user.email}: ${link}`);
  }
  return { status, error, recipient: user.email };
}

async function findManaged(role, userId, db, { lock = false } = {}) {
  const { rows } = await db.query(`SELECT * FROM users WHERE id = $1 AND role = $2 ${lock ? 'FOR UPDATE' : ''}`, [userId, role]);
  if (!rows[0]) throw notFound(LABEL[role]);
  return rows[0];
}

function splitInput(role, data) {
  const columns = toColumns(data);
  const profile = Object.fromEntries(PROFILE_FIELDS[role].filter((f) => f in columns).map((f) => [f, columns[f]]));
  return { columns, profile };
}

/**
 * Admin-created accounts must choose their own password before they can sign in. A welcome e-mail with their account
 * details and a single-use set-password link (valid SETUP_TOKEN_TTL_HOURS) goes to the account's address — passwords are
 * never e-mailed. The admin may also set a temporary password to hand over in person; without SMTP it is required, as the
 * e-mail cannot be sent. `afterCreate(user, db)` runs inside the same transaction (enrolments, referral, teaching assignments).
 * Returns the account with `welcomeEmail: { status: sent|failed|skipped, error, recipient }`.
 */
export async function createManagedAccount(role, data, actor, afterCreate) {
  if (!data.temporaryPassword && !isEmailConfigured()) {
    throw new AppError(422, 'VALIDATION_ERROR', 'Please correct the highlighted fields', {
      temporaryPassword: 'E-mail is not set up on the server, so a temporary password is required',
    });
  }
  const { profile } = splitInput(role, data);
  const { user, setup } = await withTransaction(async (db) => {
    const created = await createAccount(
      {
        role,
        email: data.email,
        fullName: data.fullName,
        phone: data.phone,
        // Without a temporary password the account gets a random one nobody knows: the set-up link is the only way in.
        password: data.temporaryPassword ?? randomToken(32),
        mustResetPassword: true,
        resetReason: 'account_created',
        profile,
      },
      db,
    );
    if (afterCreate) await afterCreate(created, db);
    await logActivity(
      {
        actorId: actor.id,
        action: `${role}.created`,
        entityType: 'user',
        entityId: created.id,
        description: `${LABEL[role]} ${created.full_name} added`,
      },
      db,
    );
    const queued = await queueSetupEmail(created, { kind: 'account_created', dedupeKey: `account:${created.id}:created` }, db);
    return { user: created, setup: queued };
  });

  const welcome = await sendSetupEmail(setup, user);
  return { ...(await getUserWithProfile(user.id)), welcomeEmail: welcome };
}

/** Send a fresh set-password link (e.g. the welcome e-mail failed or expired). Older links stop working. */
export async function sendAccountSetupEmail(role, userId, actor) {
  const { user, setup } = await withTransaction(async (db) => {
    const found = await findManaged(role, userId, db, { lock: true });
    if (!found.is_active) throw conflict('This account is deactivated. Activate it before sending a set-password e-mail.');
    const queued = await queueSetupEmail(
      found,
      { kind: 'account_setup', dedupeKey: `account:${found.id}:setup:${randomToken(9)}`, resend: true },
      db,
    );
    return { user: found, setup: queued };
  });
  const result = await sendSetupEmail(setup, user);
  await logActivity({
    actorId: actor.id,
    action: `${role}.setup_email_sent`,
    entityType: 'user',
    entityId: user.id,
    description: `Set-password e-mail to ${user.full_name}: ${result.status}`,
    metadata: { status: result.status },
  });
  return result;
}

export async function updateManagedAccount(role, userId, data, actor) {
  await withTransaction(async (db) => {
    const user = await findManaged(role, userId, db, { lock: true });
    const { columns } = splitInput(role, data);
    await updateAccount(user, columns, db);
    await logActivity(
      {
        actorId: actor.id,
        action: `${role}.updated`,
        entityType: 'user',
        entityId: userId,
        description: `${LABEL[role]} ${data.fullName} updated`,
      },
      db,
    );
  });
  return getUserWithProfile(userId);
}

/**
 * Deactivation ends every session immediately (token version bump + refresh token revocation). Reactivating a student
 * whose course access ended keeps them active until a later course end date passes (services/accessExpiry.service.js).
 */
export async function setAccountStatus(role, userId, isActive, actor) {
  await withTransaction(async (db) => {
    const user = await findManaged(role, userId, db, { lock: true });
    await db.query('UPDATE users SET is_active = $2, deactivated_reason = $3 WHERE id = $1', [userId, isActive, isActive ? null : 'admin']);
    if (!isActive) await endAllSessions(userId, db);
    else if (role === 'student') await acknowledgeEndedAccess(userId, db);
    await logActivity(
      {
        actorId: actor.id,
        action: isActive ? `${role}.activated` : `${role}.deactivated`,
        entityType: 'user',
        entityId: userId,
        description: `${LABEL[role]} ${user.full_name} ${isActive ? 'activated' : 'deactivated'}`,
      },
      db,
    );
  });
  return getUserWithProfile(userId);
}

/** For users who cannot use the email reset link: set a temporary password they must change at next sign-in. */
export async function setTemporaryPassword(role, userId, temporaryPassword, actor) {
  await withTransaction(async (db) => {
    const user = await findManaged(role, userId, db, { lock: true });
    await db.query(
      `UPDATE users SET password_hash = $2, must_reset_password = TRUE, password_reset_reason = 'admin_request' WHERE id = $1`,
      [userId, await hashPassword(temporaryPassword)],
    );
    await endAllSessions(userId, db);
    await logActivity(
      {
        actorId: actor.id,
        action: `${role}.temporary_password_set`,
        entityType: 'user',
        entityId: userId,
        description: `Temporary password set for ${user.full_name}`,
      },
      db,
    );
  });
  return { updated: true };
}
