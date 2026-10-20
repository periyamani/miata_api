import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../../middleware/validate.js';
import { id, listQuery, optionalText } from '../../../validators/common.js';
import * as ctrl from './payments.controller.js';

export const PAYMENT_STATUSES = ['pending', 'approved', 'rejected'];

const listSchema = listQuery(['created_at', 'paid_on', 'amount', 'student', 'status'], {
  status: z.enum(PAYMENT_STATUSES).optional(),
  courseId: id.optional(),
  studentId: id.optional(),
});
const paymentParams = z.object({ paymentId: id });

const router = Router();

router.get('/payments', validate({ query: listSchema }), ctrl.list);
router.get('/payments/stats', ctrl.stats);
router.get('/payments/:paymentId', validate({ params: paymentParams }), ctrl.get);
router.get('/payments/:paymentId/proof', validate({ params: paymentParams }), ctrl.proof);
// Verify a payment proof. Rejecting requires a note (the student sees it); "pending" undoes a decision.
router.patch(
  '/payments/:paymentId/status',
  validate({ params: paymentParams, body: z.object({ status: z.enum(PAYMENT_STATUSES), note: optionalText(1000) }) }),
  ctrl.setStatus,
);

export default router;
