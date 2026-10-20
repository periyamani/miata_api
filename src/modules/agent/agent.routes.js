import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { id, optionalId, optionalText } from '../../validators/common.js';
import { referralExportSchema, referralListSchema } from '../../validators/referrals.js';
import { createSchemas } from '../admin/accounts/accounts.schemas.js';
import * as ctrl from './agent.controller.js';

// Mounted at /api/agent behind authenticate + authorize('agent').
const months = z.object({ months: z.coerce.number().int().min(3).max(24).default(6) });
// Apply Now: the same student details an admin enters, plus the course applied for. Enrolment and batch stay with MIATA.
const applySchema = createSchemas.student
  .omit({ courseIds: true, agentId: true, batchId: true })
  .extend({ courseId: optionalId, notes: optionalText(1000) });

const router = Router();

router.get('/dashboard', validate({ query: months }), ctrl.dashboard);
router.get('/students', validate({ query: referralListSchema }), ctrl.students);
// agentId is never accepted from the client: the service always uses the signed-in agent.
router.get('/students/export', validate({ query: referralExportSchema.omit({ agentId: true }) }), ctrl.exportStudents);
router.get('/students/:studentId', validate({ params: z.object({ studentId: id }) }), ctrl.student);
router.get('/stats', validate({ query: months }), ctrl.stats);
router.get('/apply', ctrl.applyOptions);
router.post('/students', validate({ body: applySchema }), ctrl.apply);

export default router;
