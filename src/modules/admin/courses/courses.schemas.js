import { z } from 'zod';
import { id, isoDate, listQuery, optionalId, optionalMoney, optionalText, requiredText } from '../../../validators/common.js';

// Form values: '' means "not set".
const blankToNull = (schema) => z.preprocess((v) => (v === '' ? null : v), schema.nullish()).transform((v) => v ?? null);
const optionalDate = blankToNull(isoDate);
// 'HH:MM' from a time input, or 'HH:MM:SS' as the API returns it.
const optionalTime = blankToNull(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Use HH:MM'));
const optionalInt = (min, max, label) =>
  blankToNull(z.coerce.number({ error: `${label} must be a number` }).int(`${label} must be a whole number`).min(min).max(max));

export const DELIVERY_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'weekday', 'agreed'];

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
    // Timetable: the academic year it runs in and its first / last day (week 1 begins on the start date).
    academicYear: blankToNull(
      z
        .string()
        .trim()
        .regex(/^\d{4}[–-]\d{4}$/, 'Use the form 2026–2027'),
    ),
    startDate: optionalDate,
    endDate: optionalDate,
    scheduleNotes: optionalText(10000),
  })
  .refine((d) => (d.durationValue === null) === (d.durationUnit === null), {
    message: 'Enter both the duration and its unit',
    path: ['durationValue'],
  })
  .refine((d) => !d.academicYear || Number(d.academicYear.slice(5)) === Number(d.academicYear.slice(0, 4)) + 1, {
    message: 'The second year must follow the first, e.g. 2026–2027',
    path: ['academicYear'],
  })
  .refine((d) => !d.startDate || !d.endDate || d.endDate >= d.startDate, {
    message: 'The end date must be on or after the start date',
    path: ['endDate'],
  });

export const listCoursesQuery = listQuery(['title', 'code', 'created_at', 'students'], {
  status: z.enum(['active', 'inactive']).optional(),
});

export const statusSchema = z.object({ isActive: z.boolean() });

export const moduleSchema = z.object({
  title: requiredText(200, 'Module title'),
  description: optionalText(5000),
});

/**
 * A lesson: a curriculum topic, or a scheduled weekly session — a programme week and the course lecturer teaching it.
 */
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
  weekNumber: optionalInt(1, 104, 'Week'),
  courseLecturerId: optionalId,
});

/** A course lecturer: name exactly as on the timetable, optional professor account, delivery pattern. */
export const lecturerSchema = z
  .object({
    lecturerName: requiredText(120, 'Lecturer name'),
    professorId: optionalId,
    allocation: optionalText(2000),
    deliveryDay: blankToNull(z.enum(DELIVERY_DAYS)),
    startTime: optionalTime,
    endTime: optionalTime,
    sessionMinutes: optionalInt(15, 480, 'Session length'),
  })
  .refine((d) => !d.startTime || !d.endTime || d.endTime.slice(0, 5) > d.startTime.slice(0, 5), {
    message: 'The end time must be after the start time',
    path: ['endTime'],
  });

/** Timetable filters: one week, module or lecturer. */
export const timetableQuery = z.object({
  week: z.coerce.number().int().min(1).max(104).optional(),
  moduleId: id.optional(),
  lecturerId: id.optional(),
});

/**
 * Import a built-in timetable into an existing course, or into a new course with the given code. `dryRun` returns
 * what the import would do without saving anything. `moduleMap` maps a template module (by key) to an existing module
 * of the course, for modules whose names differ (null = create the module).
 */
export const importTimetableSchema = z
  .object({
    courseId: optionalId,
    code: blankToNull(
      z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z0-9-]{2,30}$/, 'Use 2–30 letters, numbers or dashes'),
    ),
    category: optionalText(100),
    dryRun: z.boolean().default(false),
    moduleMap: z.record(z.string().max(50), id.nullable()).default({}),
  })
  .refine((d) => d.courseId || d.code, { message: 'Enter a course code for the new course', path: ['code'] });

export const templateKeyParams = z.object({ key: z.string().trim().min(1).max(100) });

export const orderSchema = z.object({ ids: z.array(id).min(1).max(500) });

export const courseIdParams = z.object({ courseId: id });
export const moduleIdParams = z.object({ moduleId: id });
export const lessonIdParams = z.object({ lessonId: id });
export const lecturerIdParams = z.object({ lecturerId: id });

export const courseStudentsQuery = listQuery(['full_name', 'enrolled_at', 'status'], {
  status: z.enum(['active', 'suspended', 'completed']).optional(),
});
