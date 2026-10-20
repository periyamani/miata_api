import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../../middleware/validate.js';
import { boolish, id, listQuery, optionalId } from '../../../validators/common.js';
import { createSchemas, userIdParams } from '../accounts/accounts.schemas.js';
import { accountRoutes } from '../accounts/accounts.routes.js';
import * as ctrl from './students.controller.js';

const listSchema = listQuery(['full_name', 'created_at', 'student_code', 'status', 'batch'], {
  status: z.enum(['active', 'pending', 'completed', 'inactive']).optional(),
  courseId: id.optional(),
  agentId: id.optional(),
  // A batch id, or "none" for students who are not in a batch.
  batchId: z.union([id, z.literal('none')]).optional(),
  referred: boolish.optional(),
});

const router = Router();

router.get('/students', validate({ query: listSchema }), ctrl.list);
router.post('/students', validate({ body: createSchemas.student }), ctrl.create);
router.get('/students/:userId', validate({ params: userIdParams }), ctrl.get);
router.put('/students/:userId/referral', validate({ params: userIdParams, body: z.object({ agentId: optionalId }) }), ctrl.setReferral);
router.put('/students/:userId/batch', validate({ params: userIdParams, body: z.object({ batchId: optionalId }) }), ctrl.setBatch);
router.use('/students', accountRoutes('student'));

export default router;
