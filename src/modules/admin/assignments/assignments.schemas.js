import { z } from 'zod';
import { boolish, id, listQuery } from '../../../validators/common.js';

export const listAssignmentsQuery = listQuery(['title', 'due_at', 'created_at'], {
  courseId: id.optional(),
  moduleId: id.optional(),
  batchId: id.optional(),
  published: boolish.optional(),
});

export const listSubmissionsQuery = listQuery(['submitted_at', 'status', 'student', 'assignment', 'due_at'], {
  status: z.enum(['pending', 'submitted', 'in_review', 'rework', 'completed']).optional(),
  courseId: id.optional(),
  assignmentId: id.optional(),
  studentId: id.optional(),
  professorId: id.optional(),
  batchId: id.optional(),
  latestOnly: boolish.default(true),
});

export const assignmentIdParams = z.object({ assignmentId: id });
export const submissionIdParams = z.object({ submissionId: id });
