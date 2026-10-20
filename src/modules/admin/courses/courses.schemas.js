import { z } from 'zod';
import { id, listQuery, optionalMoney, optionalText, requiredText } from '../../../validators/common.js';

export const courseSchema = z
  .object({
    code: z
      .string({ error: 'Course code is required' })
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9-]{2,30}$/, 'Use 2–30 letters, numbers or dashes'),
    title: requiredText(200, 'Title'),
    description: optionalText(5000),
    category: optionalText(100),
    durationValue: z.coerce
      .number()
      .int()
      .min(1)
      .max(1000)
      .nullish()
      .transform((v) => v ?? null),
    durationUnit: z
      .enum(['days', 'weeks', 'months', 'years'])
      .nullish()
      .transform((v) => v ?? null),
    // Standard fee, copied to each new enrolment (existing enrolments keep theirs).
    feeAmount: optionalMoney('Fee'),
    isActive: z.boolean().default(true),
  })
  .refine((d) => (d.durationValue === null) === (d.durationUnit === null), {
    message: 'Enter both the duration and its unit',
    path: ['durationValue'],
  });

export const listCoursesQuery = listQuery(['title', 'code', 'created_at', 'students'], {
  status: z.enum(['active', 'inactive']).optional(),
});

export const statusSchema = z.object({ isActive: z.boolean() });

export const moduleSchema = z.object({
  title: requiredText(200, 'Module title'),
  description: optionalText(5000),
});

export const lessonSchema = z.object({
  title: requiredText(200, 'Lesson title'),
  content: optionalText(20000),
  durationMinutes: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .nullish()
    .transform((v) => v ?? null),
});

export const orderSchema = z.object({ ids: z.array(id).min(1).max(500) });

export const courseIdParams = z.object({ courseId: id });
export const moduleIdParams = z.object({ moduleId: id });
export const lessonIdParams = z.object({ lessonId: id });

export const courseStudentsQuery = listQuery(['full_name', 'enrolled_at', 'status'], {
  status: z.enum(['active', 'suspended', 'completed']).optional(),
});
