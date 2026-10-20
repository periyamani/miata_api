import { Router } from 'express';
import { validate } from '../../../middleware/validate.js';
import { id } from '../../../validators/common.js';
import { referralExportSchema, referralListSchema } from '../../../validators/referrals.js';
import * as ctrl from './referrals.controller.js';

const router = Router();

router.get('/referrals', validate({ query: referralListSchema.extend({ agentId: id.optional() }) }), ctrl.list);
router.get('/referrals/report', ctrl.report);
router.get('/referrals/export', validate({ query: referralExportSchema }), ctrl.exportCsv);

export default router;
