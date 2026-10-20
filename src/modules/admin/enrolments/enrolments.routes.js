import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../../middleware/validate.js';
import { id, isoDate, money } from '../../../validators/common.js';
import * as ctrl from './enrolments.controller.js';

const ids = (label) => z.array(id).min(1, `Select at least one ${label}`).max(200);
const enrolmentParams = z.object({ enrolmentId: id });

const router = Router();

router.post(
  '/courses/:courseId/enrolments',
  validate({ params: z.object({ courseId: id }), body: z.object({ studentIds: ids('student') }) }),
  ctrl.enrolInCourse,
);
router.post(
  '/students/:studentId/enrolments',
  validate({ params: z.object({ studentId: id }), body: z.object({ courseIds: ids('course') }) }),
  ctrl.enrolStudent,
);
router.patch(
  '/enrolments/:enrolmentId',
  validate({ params: enrolmentParams, body: z.object({ status: z.enum(['active', 'suspended']) }) }),
  ctrl.updateStatus,
);
// Access period: the student's account is deactivated automatically once their last course's end date has passed.
router.put(
  '/enrolments/:enrolmentId/schedule',
  validate({
    params: enrolmentParams,
    body: z.object({
      startDate: isoDate,
      endDate: isoDate.nullish().transform((v) => v ?? null),
    }),
  }),
  ctrl.updateSchedule,
);
router.put(
  '/enrolments/:enrolmentId/fee',
  validate({ params: enrolmentParams, body: z.object({ feeAmount: money('Fee'), discountAmount: money('Discount').default(0) }) }),
  ctrl.updateFee,
);
router.delete('/enrolments/:enrolmentId', validate({ params: enrolmentParams }), ctrl.remove);

export default router;
