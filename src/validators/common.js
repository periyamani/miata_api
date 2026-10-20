import { z } from 'zod';

export const id = z.coerce.number().int().positive();
export const idParam = z.object({ id });

/** Free text from a form: trims, turns '' into null, enforces a max length. */
export const optionalText = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

export const requiredText = (max = 200, label = 'This field') =>
  z
    .string({ error: `${label} is required` })
    .trim()
    .min(1, `${label} is required`)
    .max(max);

export const email = z.string({ error: 'Email is required' }).trim().toLowerCase().pipe(z.email('Enter a valid email address').max(254));

export const phone = z
  .preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z
      .string()
      .trim()
      .max(30)
      .regex(/^[+\d][\d\s()-]{5,29}$/, 'Enter a valid phone number')
      .nullish(),
  )
  .transform((v) => v ?? null);

export const password = z
  .string({ error: 'Password is required' })
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a number');

/** Booleans that may arrive as real booleans (JSON) or strings (query / multipart). */
export const boolish = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);

export const optionalId = z
  .union([id, z.literal(''), z.null()])
  .optional()
  .transform((v) => (v === '' || v === undefined ? null : v));

/**
 * A list of ids from JSON (array) or multipart/query ("3,7" or repeated keys). Duplicates are removed;
 * an empty value is an empty list.
 */
export const idList = (max = 500) =>
  z
    .preprocess((v) => {
      if (v === undefined || v === null || v === '') return [];
      const parts = Array.isArray(v) ? v : String(v).split(',');
      return parts.map((p) => (typeof p === 'string' ? p.trim() : p)).filter((p) => p !== '');
    }, z.array(id).max(max))
    .transform((ids) => [...new Set(ids)]);

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const isoDateTime = z.iso.datetime({ offset: true });

/** Standard list query: page, pageSize, search, sort, order. Extend with endpoint-specific filters. */
export const listQuery = (sortKeys, extra = {}) =>
  z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(10),
    search: z.string().trim().max(100).optional(),
    sort: z.enum(sortKeys).optional(),
    order: z.enum(['asc', 'desc']).default('desc'),
    ...extra,
  });

/** A money amount (numbers or form strings): 0 – 10,000,000 with at most two decimals. */
export const money = (label = 'Amount') =>
  z.coerce
    .number({ error: `${label} must be a number` })
    .min(0, `${label} cannot be negative`)
    .max(10_000_000, `${label} is too large`)
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, `${label} can have at most two decimals`);

/** An optional money amount: '' / null / undefined become null. */
export const optionalMoney = (label) =>
  z
    .preprocess((v) => (v === '' || v === undefined ? null : v), money(label).nullable())
    .optional()
    .transform((v) => v ?? null);
