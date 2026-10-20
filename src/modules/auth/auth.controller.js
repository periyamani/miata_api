import { clientIp, send, created } from '../../utils/http.js';
import { getUserWithProfile } from '../users/user.repository.js';
import { isPersistentRefreshToken } from '../../services/token.service.js';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './auth.cookies.js';
import * as authService from './auth.service.js';

const meta = (req) => ({ ip: clientIp(req), userAgent: req.get('user-agent') || null });

const sessionBody = (session) => ({ accessToken: session.accessToken, user: session.user });

export async function login(req, res) {
  const result = await authService.login(req.valid.body, meta(req));
  if (result.passwordResetRequired) {
    clearRefreshCookie(res);
    return send(res, result);
  }
  setRefreshCookie(res, result.refresh);
  send(res, sessionBody(result));
}

export async function register(req, res) {
  const session = await authService.register(req.valid.body, meta(req));
  setRefreshCookie(res, session.refresh);
  created(res, sessionBody(session));
}

export async function referralLookup(req, res) {
  send(res, await authService.lookupReferralCode(req.valid.params.code));
}

export async function refresh(req, res) {
  const token = readRefreshCookie(req);
  // No cookie at all simply means "not signed in" — not a failed authentication.
  if (!token) return send(res, null);
  try {
    const session = await authService.refreshSession(token, meta(req));
    setRefreshCookie(res, session.refresh);
    send(res, sessionBody(session));
  } catch (err) {
    clearRefreshCookie(res);
    throw err;
  }
}

export async function logout(req, res) {
  await authService.logout(readRefreshCookie(req));
  clearRefreshCookie(res);
  send(res, { loggedOut: true });
}

export async function me(req, res) {
  send(res, await getUserWithProfile(req.user.id));
}

/** Lightweight endpoint the portal polls so remotely ended sessions log out promptly. */
export function session(req, res) {
  send(res, { userId: req.user.id, role: req.user.role });
}

export async function forgotPassword(req, res) {
  await authService.requestPasswordReset(req.valid.body.email, meta(req));
  send(res, { message: 'If an account exists for that email, a password reset link has been sent.' });
}

export async function verifyResetToken(req, res) {
  send(res, await authService.verifyResetToken(req.valid.body.token));
}

export async function resetPassword(req, res) {
  const result = await authService.resetPassword(req.valid.body, meta(req));
  clearRefreshCookie(res);
  send(res, { ...result, message: 'Your password has been updated. Please sign in with your new password.' });
}

export async function changePassword(req, res) {
  const persistent = await isPersistentRefreshToken(readRefreshCookie(req));
  const session = await authService.changePassword(req.user.id, req.valid.body, { ...meta(req), persistent });
  setRefreshCookie(res, session.refresh);
  send(res, sessionBody(session));
}
