import { env } from '../../config/env.js';
import { badRequest } from '../../utils/AppError.js';

export const REFRESH_COOKIE = 'miata_rt';
// SameSite=lax works when miata-web and the API share a site (same domain, other port or subdomain);
// use COOKIE_SAMESITE=none (+ HTTPS) only when they live on different domains.
const BASE = { httpOnly: true, sameSite: env.auth.cookieSameSite, path: '/api/auth' };

/** "Remember me" sessions get a dated cookie; others end when the browser closes. */
export function setRefreshCookie(res, refresh) {
  if (!refresh) return; // parallel refresh within the grace window: browser already holds the newer cookie
  res.cookie(REFRESH_COOKIE, refresh.token, {
    ...BASE,
    secure: env.auth.cookieSecure,
    ...(refresh.persistent ? { expires: refresh.expiresAt } : {}),
  });
}

export function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, { ...BASE, secure: env.auth.cookieSecure });
}

export const readRefreshCookie = (req) => req.cookies?.[REFRESH_COOKIE] || null;

/**
 * Cookie-authenticated endpoints must be called by our own scripts: a custom header cannot be sent
 * cross-site without a CORS preflight, which our CORS policy rejects (defence in depth on top of SameSite).
 */
export function requireXhrHeader(req, _res, next) {
  if (req.get('x-requested-with') !== 'XMLHttpRequest') throw badRequest('Missing X-Requested-With header');
  next();
}
