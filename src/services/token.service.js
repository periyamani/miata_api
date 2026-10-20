import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { pool } from '../config/db.js';
import { randomToken, sha256 } from '../utils/crypto.js';

const ISSUER = 'miata';
const API_AUDIENCE = 'miata-api';
const MEDIA_AUDIENCE = 'miata-media';
const VERIFY = { issuer: ISSUER, algorithms: ['HS256'] };

// ─── Access tokens (short-lived, kept in memory by the portal) ──────────

export const signAccessToken = (user) =>
  jwt.sign({ role: user.role, tv: user.token_version }, env.auth.jwtSecret, {
    subject: String(user.id),
    expiresIn: env.auth.accessTokenTtl,
    issuer: ISSUER,
    audience: API_AUDIENCE,
  });

export const verifyAccessToken = (token) => jwt.verify(token, env.auth.jwtSecret, { ...VERIFY, audience: API_AUDIENCE });

// ─── Media tokens (signed video URLs — <video> cannot send an Authorization header) ─

export const MEDIA_TOKEN_TTL_SECONDS = 2 * 60 * 60;

export const signMediaToken = (user, videoId) =>
  jwt.sign({ vid: videoId, tv: user.token_version }, env.auth.jwtSecret, {
    subject: String(user.id),
    expiresIn: MEDIA_TOKEN_TTL_SECONDS,
    issuer: ISSUER,
    audience: MEDIA_AUDIENCE,
  });

export const verifyMediaToken = (token) => jwt.verify(token, env.auth.jwtSecret, { ...VERIFY, audience: MEDIA_AUDIENCE });

// ─── Refresh tokens (opaque, rotated on every use, stored hashed) ───────

const REUSE_GRACE_MS = 30_000;

function refreshExpiry(persistent) {
  const ms = persistent ? env.auth.refreshTokenTtlDays * 24 * 60 * 60 * 1000 : env.auth.sessionRefreshTtlHours * 60 * 60 * 1000;
  return new Date(Date.now() + ms);
}

export async function issueRefreshToken(userId, { persistent = false, userAgent = null, ip = null } = {}, db = pool) {
  const token = randomToken();
  const expiresAt = refreshExpiry(persistent);
  const { rows } = await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, persistent, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [userId, sha256(token), persistent, expiresAt, userAgent?.slice(0, 300) ?? null, ip],
  );
  return { id: rows[0].id, token, expiresAt, persistent };
}

/**
 * Exchange a refresh token for a new one.
 * Returns { userId, next } where `next` is the replacement token, or `next: null` when the token was
 * rotated moments ago by a parallel request (another tab) — the caller then issues only an access token.
 * Presenting an older revoked token is treated as theft and revokes every session of that user.
 */
export async function rotateRefreshToken(rawToken, meta, db) {
  const { rows } = await db.query(
    `SELECT id, user_id, persistent, expires_at, revoked_at, replaced_by
       FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
    [sha256(rawToken)],
  );
  const current = rows[0];
  if (!current) return { status: 'invalid' };

  if (current.revoked_at) {
    const recentlyRotated = current.replaced_by && Date.now() - current.revoked_at.getTime() < REUSE_GRACE_MS;
    if (recentlyRotated) return { status: 'ok', userId: current.user_id, next: null };
    await revokeAllRefreshTokens(current.user_id, db);
    return { status: 'reused', userId: current.user_id };
  }
  if (current.expires_at.getTime() <= Date.now()) return { status: 'expired' };

  const next = await issueRefreshToken(current.user_id, { ...meta, persistent: current.persistent }, db);
  await db.query('UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1', [current.id, next.id]);
  return { status: 'ok', userId: current.user_id, next };
}

/** Whether the given refresh token belongs to a "remember me" session (keeps the choice when re-issuing). */
export async function isPersistentRefreshToken(rawToken, db = pool) {
  if (!rawToken) return false;
  const { rows } = await db.query('SELECT persistent FROM refresh_tokens WHERE token_hash = $1', [sha256(rawToken)]);
  return rows[0]?.persistent ?? false;
}

export async function revokeRefreshToken(rawToken, db = pool) {
  await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(rawToken)]);
}

export async function revokeAllRefreshTokens(userId, db = pool) {
  await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}

/** Invalidate every access token and refresh token the user holds (immediate logout everywhere). */
export async function endAllSessions(userId, db = pool) {
  await db.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [userId]);
  await revokeAllRefreshTokens(userId, db);
}
