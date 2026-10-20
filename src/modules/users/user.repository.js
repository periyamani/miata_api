import { env } from '../../config/env.js';
import { pool } from '../../config/db.js';
import { hashPassword, randomCode } from '../../utils/crypto.js';
import { conflict } from '../../utils/AppError.js';

export const PROFILE_TABLES = {
  student: 'student_profiles',
  professor: 'professor_profiles',
  agent: 'agent_profiles',
};

// Role-profile columns that can be written through the API (never ids/codes).
export const PROFILE_FIELDS = {
  student: ['date_of_birth', 'address', 'city', 'country', 'qualification'],
  professor: ['department', 'specialization', 'qualification', 'bio'],
  agent: ['organization', 'city', 'country'],
};

/** Fields safe to return to clients — never password_hash or token_version. */
const USER_COLUMNS = `u.id, u.email, u.full_name, u.phone, u.role, u.is_active, u.deactivated_reason, u.must_reset_password,
  u.last_login_at, u.created_at, u.updated_at`;

export const referralLink = (code) => `${env.frontendUrl}/register?ref=${code}`;

export async function findUserByEmail(email, db = pool) {
  const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  return rows[0] || null;
}

export async function emailExists(email, db = pool, exceptUserId = null) {
  const { rowCount } = await db.query('SELECT 1 FROM users WHERE email = $1 AND id IS DISTINCT FROM $2', [
    email.toLowerCase(),
    exceptUserId,
  ]);
  return rowCount > 0;
}

export async function getProfile(user, db = pool) {
  const table = PROFILE_TABLES[user.role];
  if (!table) return null;
  const { rows } = await db.query(`SELECT * FROM ${table} WHERE user_id = $1`, [user.id]);
  if (!rows[0]) return null;
  const { user_id: _id, ...profile } = rows[0];
  if (user.role === 'agent') profile.referral_link = referralLink(profile.referral_code);
  return profile;
}

/** Public user shape with the role profile attached. */
export async function getUserWithProfile(userId, db = pool) {
  const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1`, [userId]);
  if (!rows[0]) return null;
  return { ...rows[0], profile: await getProfile(rows[0], db) };
}

export async function uniqueReferralCode(db) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = `AGT${randomCode(5)}`;
    const { rowCount } = await db.query('SELECT 1 FROM agent_profiles WHERE referral_code = $1', [code]);
    if (!rowCount) return code;
  }
  throw new Error('Could not generate a unique referral code');
}

/**
 * Create a user and its role profile. Must run inside a transaction (`db` = client) so a failure
 * never leaves a user without a profile.
 */
export async function createAccount(
  { role, email, fullName, phone = null, password, mustResetPassword = false, resetReason = null, profile = {} },
  db,
) {
  if (await emailExists(email, db)) {
    throw conflict('An account with this email already exists', { email: 'An account with this email already exists' });
  }
  const { rows } = await db.query(
    `INSERT INTO users (email, password_hash, full_name, phone, role, must_reset_password, password_reset_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [email.toLowerCase(), await hashPassword(password), fullName, phone, role, mustResetPassword, resetReason],
  );
  const user = rows[0];

  const table = PROFILE_TABLES[role];
  if (table) {
    const fields = PROFILE_FIELDS[role].filter((f) => profile[f] !== undefined);
    const columns = ['user_id', ...fields];
    const values = [user.id, ...fields.map((f) => profile[f])];
    if (role === 'agent') {
      columns.push('referral_code');
      values.push(await uniqueReferralCode(db));
    }
    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
    await db.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`, values);
  }
  return user;
}

/** Update whitelisted user + profile fields. `changes` uses snake_case column names. */
export async function updateAccount(user, changes, db) {
  const userFields = ['full_name', 'phone', 'email'].filter((f) => changes[f] !== undefined);
  if (changes.email !== undefined && (await emailExists(changes.email, db, user.id))) {
    throw conflict('An account with this email already exists', { email: 'An account with this email already exists' });
  }
  if (userFields.length) {
    const sets = userFields.map((f, i) => `${f} = $${i + 2}`).join(', ');
    await db.query(`UPDATE users SET ${sets} WHERE id = $1`, [user.id, ...userFields.map((f) => changes[f])]);
  }
  const table = PROFILE_TABLES[user.role];
  const profileFields = (PROFILE_FIELDS[user.role] || []).filter((f) => changes[f] !== undefined);
  if (table && profileFields.length) {
    const sets = profileFields.map((f, i) => `${f} = $${i + 2}`).join(', ');
    await db.query(`UPDATE ${table} SET ${sets} WHERE user_id = $1`, [user.id, ...profileFields.map((f) => changes[f])]);
  }
}
