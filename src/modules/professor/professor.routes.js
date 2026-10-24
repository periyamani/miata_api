import { Router } from 'express';
import { z } from 'zod';
import { uploadSingle } from '../../middleware/upload.js';
import { validate } from '../../middleware/validate.js';
import { MODULE_STATUSES } from '../../repositories/moduleStatus.repository.js';
import { boolish, id, idList, isoDateTime, listQuery, optionalId, optionalText, requiredText } from '../../validators/common.js';
import { professorMeetingRoutes } from '../meetings/meetings.routes.js';
import * as ctrl from './professor.controller.js';

// Mounted at /api/professor behind authenticate + authorize('professor').
const studentsQuery = listQuery(['full_name', 'enrolled_at', 'last_activity', 'batch'], {
  courseId: id.optional(),
  batchId: id.optional(),
  status: z.enum(['active', 'suspended', 'completed']).optional(),
});
const assignmentsQuery = listQuery(['title', 'due_at', 'created_at', 'pending'], {
  courseId: id.optional(),
  batchId: id.optional(),
  published: boolish.optional(),
});
// Sent as multipart/form-data (optional attachment), so every value may arrive as a string.
// No batchId = course-wide; batchId = that batch, narrowed to studentIds when some are selected.
const assignmentSchema = z.object({
  courseId: id,
  moduleId: optionalId,
  batchId: optionalId,
  studentIds: idList(500),
  title: requiredText(200, 'Title'),
  instructions: optionalText(10000),
  dueAt: z
    .union([isoDateTime, z.literal(''), z.null()])
    .optional()
    .transform((v) => v || null),
  isRequired: boolish.default(true),
  isPublished: boolish.default(true),
  removeAttachment: boolish.default(false),
});
const submissionsQuery = listQuery(['submitted_at', 'status', 'student', 'assignment', 'due_at'], {
  status: z.enum(['pending', 'submitted', 'in_review', 'rework', 'completed']).optional(),
  courseId: id.optional(),
  batchId: id.optional(),
  assignmentId: id.optional(),
  latestOnly: boolish.default(true),
});
const reviewSchema = z
  .object({
    decision: z.enum(['completed', 'rework']),
    feedback: z
      .string()
      .trim()
      .max(5000)
      .optional()
      .transform((v) => v || null),
  })
  .refine((v) => v.decision !== 'rework' || v.feedback, { message: 'Explain what needs to be reworked', path: ['feedback'] });

const courseParams = z.object({ courseId: id });
const moduleParams = z.object({ moduleId: id });
const moduleStatusSchema = z.object({ status: z.enum(MODULE_STATUSES, { error: 'Choose Not Started, In Progress or Completed' }) });
const assignmentParams = z.object({ assignmentId: id });
const submissionParams = z.object({ submissionId: id });
const attachment = uploadSingle('attachment', 'attachment', { required: false });
const router = Router();

router.get('/dashboard', ctrl.dashboard);
router.get('/courses', ctrl.courses);
router.get(
  '/courses/:courseId/modules',
  validate({ params: courseParams, query: z.object({ batchId: id.optional() }) }),
  ctrl.courseModules,
);
router.get('/modules', ctrl.modules);
router.put('/modules/:moduleId/status', validate({ params: moduleParams, body: moduleStatusSchema }), ctrl.setModuleStatus);
router.get('/batches', ctrl.batches);
router.get('/timetable', ctrl.timetable);
router.get('/students', validate({ query: studentsQuery }), ctrl.students);
router.get('/assignments', validate({ query: assignmentsQuery }), ctrl.assignments);
router.post('/assignments', attachment, validate({ body: assignmentSchema }), ctrl.createAssignment);
router.get('/assignments/:assignmentId', validate({ params: assignmentParams }), ctrl.assignment);
router.put('/assignments/:assignmentId', attachment, validate({ params: assignmentParams, body: assignmentSchema }), ctrl.updateAssignment);
router.delete('/assignments/:assignmentId', validate({ params: assignmentParams }), ctrl.deleteAssignment);
router.get('/assignments/:assignmentId/attachment', validate({ params: assignmentParams }), ctrl.assignmentAttachment);
router.get('/submissions', validate({ query: submissionsQuery }), ctrl.submissions);
router.get('/submissions/:submissionId', validate({ params: submissionParams }), ctrl.submission);
router.get('/submissions/:submissionId/file', validate({ params: submissionParams }), ctrl.submissionFile);
router.post('/submissions/:submissionId/start-review', validate({ params: submissionParams }), ctrl.startReview);
router.post(
  '/submissions/:submissionId/comments',
  validate({ params: submissionParams, body: z.object({ body: requiredText(5000, 'Comment') }) }),
  ctrl.comment,
);
router.post('/submissions/:submissionId/review', validate({ params: submissionParams, body: reviewSchema }), ctrl.review);
router.use(professorMeetingRoutes);

export default router;
