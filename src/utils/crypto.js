import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';

/** URL-safe random token for refresh / password-reset links. */
export const randomToken = (bytes = 48) => crypto.randomBytes(bytes).toString('base64url');

/** Tokens are stored as SHA-256 hashes, so a database leak does not expose usable tokens. */
export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export const hashPassword = (plain) => bcrypt.hash(plain, env.auth.bcryptRounds);
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

// Compared against when the email is unknown so response time does not reveal which accounts exist.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-password', 4);
export const verifyAgainstDummy = (plain) => bcrypt.compare(plain, DUMMY_HASH);

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion when read aloud
export function randomCode(length) {
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}
