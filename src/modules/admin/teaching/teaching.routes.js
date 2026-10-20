import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../../middleware/validate.js';
import { id } from '../../../validators/common.js';
import * as ctrl from './teaching.controller.js';

const body = z.object({ professorId: id });
const router = Router();

router.post('/courses/:courseId/professors', validate({ params: z.object({ courseId: id }), body }), ctrl.assignToCourse);
router.delete(
  '/courses/:courseId/professors/:professorId',
  validate({ params: z.object({ courseId: id, professorId: id }) }),
  ctrl.unassignFromCourse,
);
router.post('/modules/:moduleId/professors', validate({ params: z.object({ moduleId: id }), body }), ctrl.assignToModule);
router.delete(
  '/modules/:moduleId/professors/:professorId',
  validate({ params: z.object({ moduleId: id, professorId: id }) }),
  ctrl.unassignFromModule,
);

export default router;
