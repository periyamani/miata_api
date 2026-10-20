import { z } from 'zod';
import { pool } from '../config/db.js';

export const completionPolicySchema = z
  .object({
    requireAllVideos: z.boolean(),
    requireAllAssignments: z.boolean(),
    videoWatchThreshold: z.number().int().min(50).max(100),
    logoutOnCompletion: z.boolean(),
    passwordResetOnCompletion: z.enum(['next_login', 'email_link', 'none']),
  })
  .refine((p) => p.requireAllVideos || p.requireAllAssignments, {
    message: 'At least one completion requirement (videos or assignments) must be enabled',
    path: ['requireAllVideos'],
  });

export const DEFAULT_COMPLETION_POLICY = Object.freeze({
  requireAllVideos: true,
  requireAllAssignments: true,
  videoWatchThreshold: 90,
  logoutOnCompletion: true,
  passwordResetOnCompletion: 'next_login',
});

export async function getCompletionPolicy(db = pool) {
  const { rows } = await db.query(`SELECT value FROM app_settings WHERE key = 'completion_policy'`);
  return { ...DEFAULT_COMPLETION_POLICY, ...(rows[0]?.value || {}) };
}

export async function saveCompletionPolicy(policy, userId, db = pool) {
  await db.query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('completion_policy', $1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(policy), userId],
  );
  return policy;
}

// ─── Fees ───────────────────────────────────────────────────────────────

export const feeSettingsSchema = z.object({
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code, e.g. AUD'),
  // Shown to students on their Fees page: where and how to transfer the fee.
  paymentInstructions: z.string().trim().max(2000).default(''),
});

export const DEFAULT_FEE_SETTINGS = Object.freeze({ currency: 'AUD', paymentInstructions: '' });

export async function getFeeSettings(db = pool) {
  const { rows } = await db.query(`SELECT value FROM app_settings WHERE key = 'fee_settings'`);
  return { ...DEFAULT_FEE_SETTINGS, ...(rows[0]?.value || {}) };
}

export async function saveFeeSettings(settings, userId, db = pool) {
  await db.query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('fee_settings', $1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(settings), userId],
  );
  return settings;
}
