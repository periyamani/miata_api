import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env.js';

const limiter = (windowMinutes, limit, message, extra = {}) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // Integration tests fire many requests from one address; limits are covered separately.
    skip: () => env.isTest && !process.env.TEST_RATE_LIMITS,
    handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message } }),
    ...extra,
  });

export const loginLimiter = limiter(15, 10, 'Too many login attempts. Please wait 15 minutes and try again.', {
  skipSuccessfulRequests: true,
});
export const passwordResetLimiter = limiter(15, 5, 'Too many password reset requests. Please try again later.');
export const registerLimiter = limiter(60, 10, 'Too many registrations from this network. Please try again later.');
export const enquiryLimiter = limiter(10, 5, 'Too many enquiries submitted. Please try again in a few minutes.');
export const resetTokenLimiter = limiter(15, 20, 'Too many attempts. Please request a new reset link or try again later.');
export const apiLimiter = limiter(15, 1000, 'Too many requests. Please slow down.');
