import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../../middleware/validate.js';
import { listQuery } from '../../../validators/common.js';
import { referralListSchema } from '../../../validators/referrals.js';
import { createSchemas, userIdParams } from '../accounts/accounts.schemas.js';
import { accountRoutes } from '../accounts/accounts.routes.js';
import * as ctrl from './agents.controller.js';

const listSchema = listQuery(['full_name', 'created_at', 'referrals'], {
  status: z.enum(['active', 'inactive']).optional(),
});

const router = Router();

router.get('/agents', validate({ query: listSchema }), ctrl.list);
router.post('/agents', validate({ body: createSchemas.agent }), ctrl.create);
router.get('/agents/:userId', validate({ params: userIdParams }), ctrl.get);
router.get('/agents/:userId/referrals', validate({ params: userIdParams, query: referralListSchema }), ctrl.referrals);
router.post('/agents/:userId/referral-code', validate({ params: userIdParams }), ctrl.regenerateCode);
router.use('/agents', accountRoutes('agent'));

export default router;
