import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../../middleware/validate.js';
import { id, listQuery } from '../../../validators/common.js';
import { createSchemas, userIdParams } from '../accounts/accounts.schemas.js';
import { accountRoutes } from '../accounts/accounts.routes.js';
import * as ctrl from './professors.controller.js';

const listSchema = listQuery(['full_name', 'created_at', 'pending_reviews'], {
  status: z.enum(['active', 'inactive']).optional(),
  courseId: id.optional(),
});

const router = Router();

router.get('/professors', validate({ query: listSchema }), ctrl.list);
router.post('/professors', validate({ body: createSchemas.professor }), ctrl.create);
router.get('/professors/:userId', validate({ params: userIdParams }), ctrl.get);
router.use('/professors', accountRoutes('professor'));

export default router;
