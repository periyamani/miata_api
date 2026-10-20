import { z } from 'zod';
import { isoDate, optionalText, password, phone, requiredText } from '../../validators/common.js';

const base = { fullName: requiredText(120, 'Full name').optional(), phone: phone.optional() };

/** What each role may change about themselves. Email, codes and department are admin-managed. */
export const selfProfileSchemas = {
  admin: z.object(base),
  student: z.object({
    ...base,
    dateOfBirth: isoDate.nullish(),
    address: optionalText(300).optional(),
    city: optionalText(100).optional(),
    country: optionalText(100).optional(),
    qualification: optionalText(200).optional(),
  }),
  professor: z.object({
    ...base,
    specialization: optionalText(200).optional(),
    qualification: optionalText(200).optional(),
    bio: optionalText(2000).optional(),
  }),
  agent: z.object({
    ...base,
    organization: optionalText(200).optional(),
    city: optionalText(100).optional(),
    country: optionalText(100).optional(),
  }),
};

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required').max(128),
  newPassword: password,
});
