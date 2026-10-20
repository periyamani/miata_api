import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../../middleware/validate.js';
import { id } from '../../../validators/common.js';
import * as ctrl from './lookups.controller.js';

const peopleQuery = z.object({
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const router = Router();

router.get('/lookups/courses', ctrl.courses);
router.get('/lookups/batches', ctrl.batches);
router.get('/lookups/courses/:courseId/curriculum', validate({ params: z.object({ courseId: id }) }), ctrl.curriculum);
router.get('/lookups/students', validate({ query: peopleQuery }), ctrl.people('student'));
router.get('/lookups/professors', validate({ query: peopleQuery }), ctrl.people('professor'));
router.get('/lookups/agents', validate({ query: peopleQuery }), ctrl.people('agent'));
router.get('/search', validate({ query: z.object({ q: z.string().trim().min(2).max(100) }) }), ctrl.search);

export default router;
