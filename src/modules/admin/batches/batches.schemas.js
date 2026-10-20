import { z } from 'zod';
import { id, isoDate, listQuery, optionalText, requiredText } from '../../../validators/common.js';

const optionalDate = z.preprocess((v) => (v === '' ? null : v), isoDate.nullish()).transform((v) => v ?? null);

const batchFields = {
  code: z
    .string({ error: 'Batch code is required' })
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,30}$/, 'Use 2–30 letters, numbers or dashes'),
  name: requiredText(200, 'Batch name'),
  description: optionalText(2000),
  startDate: optionalDate,
  endDate: optionalDate,
  isActive: z.boolean().default(true),
};

const datesInOrder = [
  (d) => !d.startDate || !d.endDate || d.endDate >= d.startDate,
  { message: 'The end date must be on or after the start date', path: ['endDate'] },
];

/** Creating a batch can also attach its courses and professors in one step. */
export const createBatchSchema = z
  .object({
    ...batchFields,
    courseIds: z.array(id).max(50).default([]),
    professorIds: z.array(id).max(50).default([]),
  })
  .refine(...datesInOrder);
export const updateBatchSchema = z.object(batchFields).refine(...datesInOrder);
export const statusSchema = z.object({ isActive: z.boolean() });

export const listBatchesQuery = listQuery(['name', 'code', 'start_date', 'created_at', 'students'], {
  status: z.enum(['active', 'inactive']).optional(),
  courseId: id.optional(),
  professorId: id.optional(),
});
export const batchStudentsQuery = listQuery(['full_name', 'added_at', 'student_code']);

export const studentIdsSchema = z.object({ studentIds: z.array(id).min(1, 'Select at least one student').max(200) });
export const courseSchema = z.object({ courseId: id });
export const professorSchema = z.object({ professorId: id });
/** Batches a module or video is restricted to; an empty list makes it available to every batch. */
export const availabilitySchema = z.object({ batchIds: z.array(id).max(100) });

export const batchIdParams = z.object({ batchId: id });
export const batchStudentParams = z.object({ batchId: id, studentId: id });
export const batchCourseParams = z.object({ batchId: id, courseId: id });
export const batchProfessorParams = z.object({ batchId: id, professorId: id });
export const moduleIdParams = z.object({ moduleId: id });
export const videoIdParams = z.object({ videoId: id });
