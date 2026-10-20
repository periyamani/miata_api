import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { loginLimiter, passwordResetLimiter, registerLimiter, resetTokenLimiter } from '../../middleware/rateLimiters.js';
import { requireXhrHeader } from './auth.cookies.js';
import * as ctrl from './auth.controller.js';
import * as s from './auth.schemas.js';

const router = Router();

router.post('/login', loginLimiter, validate({ body: s.loginSchema }), ctrl.login);
router.post('/register', registerLimiter, validate({ body: s.registerSchema }), ctrl.register);
router.get('/referral/:code', validate({ params: s.referralCodeParams }), ctrl.referralLookup);
router.post('/refresh', requireXhrHeader, ctrl.refresh);
router.post('/logout', requireXhrHeader, ctrl.logout);
router.post('/forgot-password', passwordResetLimiter, validate({ body: s.forgotPasswordSchema }), ctrl.forgotPassword);
router.post('/reset-password/verify', resetTokenLimiter, validate({ body: s.resetTokenSchema }), ctrl.verifyResetToken);
router.post('/reset-password', resetTokenLimiter, validate({ body: s.resetPasswordSchema }), ctrl.resetPassword);
router.get('/me', authenticate, ctrl.me);
router.get('/session', authenticate, ctrl.session);

export default router;
