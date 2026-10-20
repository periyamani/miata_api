import { z } from 'zod';
import { email, id, isoDate, optionalId, optionalText, password, phone, requiredText } from '../../../validators/common.js';

const identity = { fullName: requiredText(120, 'Full name'), email, phone };
const temporaryPassword = { temporaryPassword: password };
// On create the temporary password is optional: the welcome e-mail carries a set-password link.
const optionalTemporaryPassword = { temporaryPassword: z.preprocess((v) => (v === '' || v === null ? undefined : v), password.optional()) };

const studentProfile = {
  dateOfBirth: isoDate.nullish().transform((v) => v ?? null),
  address: optionalText(300),
  city: optionalText(100),
  country: optionalText(100),
  qualification: optionalText(200),
};
const professorProfile = {
  department: optionalText(150),
  specialization: optionalText(200),
  qualification: optionalText(200),
  bio: optionalText(2000),
};
const agentProfile = {
  organization: optionalText(200),
  city: optionalText(100),
  country: optionalText(100),
};

export const createSchemas = {
  student: z.object({
    ...identity,
    ...optionalTemporaryPassword,
    ...studentProfile,
    courseIds: z.array(id).max(20).default([]),
    agentId: optionalId,
    // Optional batch: the student joins it and is enrolled in its courses.
    batchId: optionalId,
  }),
  professor: z.object({ ...identity, ...optionalTemporaryPassword, ...professorProfile, courseIds: z.array(id).max(50).default([]) }),
  agent: z.object({ ...identity, ...optionalTemporaryPassword, ...agentProfile }),
};

export const updateSchemas = {
  student: z.object({ ...identity, ...studentProfile }),
  professor: z.object({ ...identity, ...professorProfile }),
  agent: z.object({ ...identity, ...agentProfile }),
};

export const statusSchema = z.object({ isActive: z.boolean() });
export const temporaryPasswordSchema = z.object(temporaryPassword);
export const userIdParams = z.object({ userId: id });
