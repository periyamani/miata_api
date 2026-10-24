import { Router } from 'express';
import { z } from 'zod';
import { uploadSingle } from '../../middleware/upload.js';
import { validate } from '../../middleware/validate.js';
import { id, isoDate, money, optionalText, requiredText } from '../../validators/common.js';
import { studentMeetingRoutes } from '../meetings/meetings.routes.js';
import * as ctrl from './student.controller.js';

// Mounted at /api/student behind authenticate + authorize('student').
const courseParams = z.object({ courseId: id });
const videoParams = z.object({ videoId: id });
const assignmentParams = z.object({ assignmentId: id });
const submissionParams = z.object({ submissionId: id });

const router = Router();

router.get('/dashboard', ctrl.dashboard);
router.get('/courses', ctrl.courses);
router.get('/courses/:courseId', validate({ params: courseParams }), ctrl.course);
router.get('/modules', validate({ query: z.object({ courseId: id.optional() }) }), ctrl.modules);
router.get('/timetable', ctrl.timetable);

router.get(
  '/videos',
  validate({ query: z.object({ courseId: id.optional(), moduleId: id.optional(), status: z.enum(['watched', 'unwatched']).optional() }) }),
  ctrl.videos,
);
router.get('/videos/:videoId', validate({ params: videoParams }), ctrl.video);
router.post(
  '/videos/:videoId/progress',
  validate({
    params: videoParams,
    body: z.object({
      position: z
        .number()
        .min(0)
        .max(24 * 3600),
    }),
  }),
  ctrl.videoProgress,
);

router.get(
  '/assignments',
  validate({
    query: z.object({ courseId: id.optional(), status: z.enum(['pending', 'submitted', 'in_review', 'rework', 'completed']).optional() }),
  }),
  ctrl.assignments,
);
router.get('/assignments/:assignmentId', validate({ params: assignmentParams }), ctrl.assignment);
router.get('/assignments/:assignmentId/attachment', validate({ params: assignmentParams }), ctrl.assignmentAttachment);
router.post(
  '/assignments/:assignmentId/submissions',
  uploadSingle('file', 'submission'),
  validate({ params: assignmentParams, body: z.object({ notes: optionalText(2000) }) }),
  ctrl.submit,
);

router.get('/submissions', ctrl.submissions);
router.get('/submissions/:submissionId/file', validate({ params: submissionParams }), ctrl.submissionFile);
router.post(
  '/submissions/:submissionId/comments',
  validate({ params: submissionParams, body: z.object({ body: requiredText(5000, 'Comment') }) }),
  ctrl.comment,
);

router.get('/fees', ctrl.fees);
// Report a fee payment: the proof (screenshot or receipt) in the "proof" field. An admin verifies it.
router.post(
  '/payments',
  uploadSingle('proof', 'payment_proof'),
  validate({
    body: z.object({
      courseId: id,
      amount: money('Amount').refine((v) => v > 0, 'Enter the amount you paid'),
      paidOn: isoDate.refine((d) => d >= '2000-01-01', 'Enter the date of the payment'),
      method: z.enum(['bank_transfer', 'upi', 'card', 'cash', 'cheque', 'other']).default('bank_transfer'),
      reference: optionalText(100),
      notes: optionalText(1000),
    }),
  }),
  ctrl.submitPayment,
);
router.get('/payments/:paymentId/proof', validate({ params: z.object({ paymentId: id }) }), ctrl.paymentProof);

router.get('/progress', ctrl.progress);
router.get('/completion', ctrl.completion);
router.use(studentMeetingRoutes);

export default router;
