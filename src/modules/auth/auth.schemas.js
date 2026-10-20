import { z } from 'zod';
import { email, password, phone, requiredText } from '../../validators/common.js';

export const loginSchema = z.object({
  email,
  password: z.string({ error: 'Password is required' }).min(1, 'Password is required').max(128),
  remember: z.boolean().default(false),
  // The role chosen on the login page (Admin / Student / Professor / Agent).
  role: z.enum(['admin', 'agent', 'professor', 'student']).optional(),
});

export const registerSchema = z.object({
  fullName: requiredText(120, 'Full name'),
  email,
  phone,
  password,
  referralCode: z
    .string()
    .trim()
    .toUpperCase()
    .max(16)
    .optional()
    .transform((v) => v || null),
  acceptTerms: z.literal(true, { error: 'You must accept the privacy policy' }),
});

export const referralCodeParams = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{6,16}$/, 'Invalid referral code'),
});

export const forgotPasswordSchema = z.object({ email });

export const resetTokenSchema = z.object({ token: z.string().min(20).max(200) });

export const resetPasswordSchema = z.object({ token: z.string().min(20).max(200), password });
